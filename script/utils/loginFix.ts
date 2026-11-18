// 登录页通用修版：Scripting 弹出 WebView 时有一条半透明导航栏浮在页面顶部（约 116pt），
// 很多平台的登录页把自己画在 y=0（或 position:fixed 贴顶），标题/关闭按钮/输入框就被压在栏下面。
// 这里不针对某一家写死：body 整体下推 + 把贴顶的 fixed/sticky 元素一起推下去，
// 全屏弹层（如唯品会登录层）改用 padding-top 让背景仍铺满。
// JD 有自己的 JD_LOGIN_FIX（京东换步骤时头部会重建），那份保留，其余平台统一用这份。
export const LOGIN_INSET_FIX = `(function(){
  var BAR = 116;
  var PAD = 'calc(max(env(safe-area-inset-top, 0px), ' + BAR + 'px) + 8px)';
  var CSS = [
    'html{scroll-padding-top:' + BAR + 'px!important;}',
    'body{padding-top:' + PAD + '!important;box-sizing:border-box!important;}',
    'input,textarea,select{font-size:16px!important;}'
  ].join('');
  function style(){
    var st = document.getElementById('cc-login-fix');
    if(!st){ st = document.createElement('style'); st.id = 'cc-login-fix'; (document.head || document.documentElement).appendChild(st); }
    if(st.textContent !== CSS) st.textContent = CSS;
  }
  function push(){
    var vh = window.innerHeight || 800;
    var small = 0, tall = 0;
    var all = document.querySelectorAll('body *');
    for(var i = 0; i < all.length && (small < 30 || tall < 6); i++){
      var el = all[i];
      if(el.getAttribute('data-cc-lf') === '1') continue;
      var cs = getComputedStyle(el);
      if(cs.position !== 'fixed' && cs.position !== 'sticky') continue;
      var r = el.getBoundingClientRect();
      if(r.top > 8) continue;
      if(r.height >= vh * 0.55){
        // 全屏层：留白会把整块顶下去、底下露出白条，所以用内边距
        if(tall >= 6) continue;
        el.style.setProperty('padding-top', PAD, 'important');
        el.style.boxSizing = 'border-box';
        tall++;
      } else {
        if(small >= 30) continue;
        el.style.setProperty('margin-top', PAD, 'important');
        small++;
      }
      el.setAttribute('data-cc-lf', '1');
    }
  }
  style(); push();
  var n = 0;
  var iv = setInterval(function(){ style(); if(n < 30) push(); if(++n > 60) clearInterval(iv); }, 300);
})()`

/**
 * 唯品会自动登录：**一次一步**的脚本，由 App 侧用 evaluateJavaScript 每 800ms 调用一次。
 *
 * 两个实测结论决定了现在的写法：
 * 1. `evaluateJavaScript` 把字符串当“函数体”，表达式不写 `return` 一律拿不到值（返回 null）。
 * 2. 登录框不必从首页点出来：`https://m.vip.com/v3/index.html#/pages/userCenter/userCenter`
 *    可以直达「个人中心」，那里没有首页的新人券弹窗，只剩一个「登录/注册」要点。
 *
 * 所以流程缩成：限流就点重试 → 有弹层就关 → 点一次「登录/注册」 → 出现手机号输入框即完成。
 * 状态机放在 window.__vipA 上，跨调用保留（页面重载会重置，正好也该重置）。
 */
export const VIP_AUTO_STEP = `(function(){
  if(!window.__vipA){
    window.__vipA = (function(){
      function vis(e){ try{ var r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 }catch(_){ return false } }
      function bodyText(){ try{ return (document.body && document.body.innerText) || '' }catch(e){ return '' } }
      function tel(){
        var a = document.querySelectorAll('input[type=tel],input[type=number],input[placeholder*="手机"]');
        for(var i=0;i<a.length;i++){ if(vis(a[i])) return true }
        return false;
      }
      /** 按文字找“能点的小块”，限制尺寸避开整页容器 */
      function findText(s){
        var all = document.querySelectorAll('div,span,a,p,button,i');
        for(var i=0;i<all.length;i++){
          var e = all[i];
          if(String(e.textContent || '').trim() !== s) continue;
          if(!vis(e)) continue;
          var r = e.getBoundingClientRect();
          if(r.height > 90 || r.width > 320) continue;
          return e;
        }
        return null;
      }
      /** 有没有盖住页面的弹层：新人券、“仅APP可用”活动页、通用弹窗都算 */
      function popupOpen(){
        if(/仅APP可用|限时惊喜|开心收下|新人专享|领取成功/.test(bodyText())) return true;
        var p = document.querySelector('.uni-popup__wrapper,.uni-popup,.van-popup,.van-overlay,[class*=dialog]');
        return !!(p && vis(p));
      }
      /** 尽量关掉弹层：close 类小按钮 → 文本 × → 点蒙层 */
      function closePopup(){
        var c = document.querySelectorAll('[class*=close],[class*=Close],[aria-label*="关闭"]');
        for(var i=0;i<c.length;i++){
          var e = c[i]; if(!vis(e)) continue;
          var r = e.getBoundingClientRect();
          if(r.width >= 14 && r.width <= 100 && r.height >= 14 && r.height <= 100){ try{ e.click(); return true }catch(_){} }
        }
        var x = findText('×') || findText('✕') || findText('╳') || findText('关闭');
        if(x){ try{ x.click(); return true }catch(_){ } }
        var ov = document.querySelector('.van-overlay,.uni-popup__wrapper');
        if(ov && vis(ov)){ try{ ov.click(); return true }catch(_){ } }
        return false;
      }
      var startedAt = 0, entryAt = 0, entryTries = 0, tabAt = 0;
      var popAt = 0, popTries = 0, retryAt = 0, retryTries = 0, reloaded = 0;

      function step(){
        if(!startedAt) startedAt = Date.now();
        if(tel()) return 'login-open';
        if(document.readyState !== 'complete') return 'doc-loading';
        if(bodyText().length < 60) return 'body-empty';
        // 唯品会经常先给一页“现在抢购的小伙伴太多了”，点重试就好
        if(/小伙伴太多|抢购的小伙伴|系统繁忙|稍后再试/.test(bodyText())){
          if(retryTries >= 4){
            if(!reloaded && Date.now() - retryAt > 15000){
              reloaded = 1;
              try{ location.reload() }catch(e){ return 'reload' }
              return 'reload';
            }
            return 'throttle-giveup';
          }
          if(retryAt && Date.now() - retryAt < 2000) return 'throttle-wait';
          var rb = findText('重试');
          retryAt = Date.now();
          if(!rb) return 'throttle-no-btn';
          retryTries++;
          try{ rb.click() }catch(_){ }
          return 'throttle-retry' + retryTries;
        }
        if(popTries < 6 && popupOpen()){
          if(popAt && Date.now() - popAt < 900) return 'popup-wait';
          popAt = Date.now(); popTries++;
          return closePopup() ? 'popup-closed' : 'popup-stuck';
        }
        if(entryTries < 6){
          if(entryAt && Date.now() - entryAt < 1500) return 'entry-wait';
          var e = document.querySelector('.unlogin__right-title');
          if(!e || !vis(e)) e = findText('登录/注册') || findText('登录') || findText('立即登录');
          if(e){
            entryAt = Date.now(); entryTries++;
            try{ e.click() }catch(_){ }
            return 'entry-clicked' + entryTries;
          }
        } else if(!tabAt && Date.now() - startedAt > 6000){
          // 兜底：进了首页而不是个人中心时，点一下底部 tab
          var tabs = document.querySelectorAll('.uni-tabbar__item');
          var t = (tabs && tabs.length) ? tabs[tabs.length - 1] : findText('个人中心');
          if(!t) return 'no-tabbar';
          tabAt = Date.now(); entryTries = 0; entryAt = 0;
          try{ t.click() }catch(_){ }
          return 'tab-clicked';
        }
        return 'entry-missing';
      }
      return { step: step };
    })();
  }
  return window.__vipA.step();
})()`

