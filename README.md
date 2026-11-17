# 包裹助手（远程更新 1.2.8）

这是 Scripting App 脚本「包裹助手」的远程更新副本，版本 **1.2.8**。公开仓库为 [`marrylily/scripting-parcel`](https://github.com/marrylily/scripting-parcel)，分支 `main`，脚本目录 `script/`。

1.2.8 修的是：H5 订单页超时后不再把整轮直接停掉。加载前会记录官方导航事件里看到的地址，超时文案分开写请求地址和实际观察到的地址。已知登录页或 App 唤起会停下来并提示前台授权。超时后的「暂无订单」或读取失败不会被当成 0 单成功。预算还够就继续原来的 PC 订单页。登录态和钥匙串内容不改。本版没有在真机上验证，也**不保证**打开 Surge 后淘宝一定能同步成功。

若要改仓库名，请同时修改：

1. 本仓库根目录的 `publish.config.json`
2. `script/script.json` 里的 `remoteResource.url`
3. 本 README 中的链接

## 目录说明

| 路径 | 作用 |
| --- | --- |
| `script/` | 给 Scripting 导入/远程更新用的脚本目录，内含 `script.json` 和入口文件 |
| `releases/包裹助手_远程更新_1.2.8.zip` | 与 `script/` 内容相同的打包 zip，zip 根目录就是 `script.json`，便于手动导入 |
| `publish.config.json` | 仓库名、分支、远程 URL 的占位配置 |
| `NOTICE.md` | 作者、许可与第三方来源说明（公开前请先阅读） |

## 在 iPhone 的 Scripting 里导入

任选一种方式：

1. **用 GitHub 地址导入（推荐，便于之后远程更新）**  
   在 Scripting 中导入脚本，地址填写：

   `https://github.com/marrylily/scripting-parcel/tree/main/script`

   官方文档把这种形式列为「某 revision 内的脚本子目录」。不要填仓库首页的网页说明，也不要填无法直接下载的 Release 展示页。

2. **用打包文件导入**  
   把 `releases/包裹助手_远程更新_1.2.8.zip` 传到手机，在 Scripting 里作为脚本包导入。合并到 `main` 之前，已安装脚本的远程更新不会变成 1.2.8。

导入后会出现独立脚本「包裹助手（远程更新）」，**不会自动覆盖**原来的「包裹助手」或先前的 1.2.1 / 1.2.2 诊断包。首次使用仍按 `script/README.md`：在设置里授权你要用的平台。已有登录态在系统钥匙串里，一般不必重新登录；本版本也没有改登录或密钥逻辑。

## 远程更新如何工作

依据 Scripting 官方文档（见文末链接）：

- `script/script.json` 已填写 `remoteResource`，只包含文档列出的两个字段：
  - `url`：`https://github.com/marrylily/scripting-parcel/tree/main/script`
  - `autoUpdateInterval`：`3600`（秒，约每小时请求检查一次）
- **不要**自行编写或复制 `hash`。文档写明：`hash` 由 App 维护，不要把不完整的 `remoteResource` 拷进 `script.json`，也不要编造 hash。
- 间隔单位是秒，**实际最小为 1800 秒（30 分钟）**。更小的值会被提高到 1800。省略或设为 `null` 则关闭该脚本的定时检查。这只是调度间隔，不保证 App 挂起时仍准时执行。
- App 里还有一个**全局「自动更新」开关**：打开时，检查到更新会自动替换脚本文件；关闭时，定时检查仍可发现并标记待更新，但不会自动替换。手动检查不依赖这里的间隔。
- 文档要求保持远程 URL 稳定，并**递增 `version` 便于识别更新**。文档**没有**写「只用 version 字段判断是否有更新」；更新比对由 App 维护的 `hash` 负责。因此发新版时请改代码或资源后同时把 `script.json` 的 `version` 往上加，例如 1.2.6 → 1.2.7。
- 远程目录必须包含 `script.json` 和入口文件（本仓库是 `script/index.tsx`）。ZIP 应是可直接下载的归档；也可以有一层外包目录。不要把多个无关顶层文件夹打进同一个 ZIP。
- GitHub 链接由 App 解析，不是通用 Git/SSH 客户端。`tree` 后面第一段当作 revision，分支名不要带 `/`。
- 官方未把 `raw.githubusercontent.com` 或 GitHub Release 展示页单列为来源格式。若改用 ZIP，请用**可以直接下载文件的地址**（例如日后 Release 的 `releases/download/.../xxx.zip`），不要用 Release 网页。本仓库默认使用已文档化的 GitHub 子目录地址，不依赖 raw。

导入后，请到该脚本的设置里确认远程来源和自动更新开关与预期一致。

更新脚本时：修改 `script/` 下的文件，提高 `version`，推送到同一 `url` 指向的目录即可。不要改 URL，除非仓库搬家（搬家时同步改 `publish.config.json`、`script.json` 和本说明）。

## 与先前版本的关系

已发给真机试用的 1.2.1 / 1.2.2 诊断包，以及原先的 1.2.0、1.2.3 远程更新包，都保持不动。本脚本显示名仍是稳定的「包裹助手（远程更新）」，导入后不会自动覆盖那些旧副本。

1.2.3 主要加入远程来源。1.2.4 安全包装了会触发 Timer 错误的计时器。1.2.5 修的是淘宝「上次同步」被全局 3 小时闸门和轻量刷新节流挡住的问题。1.2.6 让淘宝超时原因可定位，并建议 Surge 对阿里系域名走直连。1.2.7 让卡住的页面加载能够按时结束，并避免自动同步和手动同步共用一份诊断。1.2.8 让 H5 订单页超时之后还能继续 PC 订单页；登录页和验证页仍会停止。

## 1.2.8 和加载超时

Scripting 文档写明：`loadRequest` 成功解析为 `true` 只表示主文档加载成功，失败、取消或被替换解析为 `false`。`timeoutInterval` 是这一次导航请求的超时，单位是秒。导航回调不覆盖每一个图片或脚本请求。文档提交（`commit`）可以早于 `loadFinish`，所以页面里可能已经有数据，导航却还没被算作成功。1.2.7 把这种非成功结果写成带「淘宝·」的超时，外层又把所有「淘宝·」错误当成整轮失败，于是两次 20 秒的 H5 尝试之后不会打开 PC 页。真机 20:36 的诊断是同一轮共 40.3 秒、先 20.0 秒再 20.1 秒，和这段路径一致。不能据此证明是 Surge 把子资源拖住了。

## 1.2.7 修了什么，没有证明什么

已从 1.2.6 的诊断和代码对上的问题：

- 「整轮时间预算用尽」的耗时被写成 0.0 秒，因为抛错时传入的经过时间是常数 0。
- 同一次诊断里，总耗时可以是 138.3 秒或 131.7 秒，而「加载 H5 订单页」却是 377.7 秒或 621.5 秒。步骤时钟和总时钟不是同一轮，说明后一次 `begin` 换掉了共享诊断，前一次仍往里面补记。
- 打开 App 的自动同步和「立即同步」都能进入淘宝页面。原来的 20 秒锁过期后不会释放，两轮可以叠在一起。
- `loadURL` 返回后还会再等一次 `waitForLoad`。协作式截止时间只在两次等待之间看 `Date.now()`，等不到返回就不会触发。按钮的 `finally` 也要等这次等待结束，所以会停在「正在同步」。
- 计时器排不上时，旧的竞速会一直等原来的 Promise。

没有证明的部分：Surge 打开时同步失败、域名已直连、MITM 关闭、UDP 放行，以及 `h5api.m.taobao.com` 在约 31.5 秒被重置。这些只能说明网络路径和脚本挂起同时出现过。`h5.m.taobao.com` 的 TCP 约 52 毫秒就建立，不能据此断定页面加载失败的原因。1.2.7 不把 Surge 连通性当成已修复。

## Surge 建议：淘宝相关域名走直连

在中国大陆使用 Surge 时，若把淘宝/阿里域名分流到海外节点，订单页和 mtop 网关往往会很慢，甚至被收成超时。脚本实际会访问（以及订单页还可能加载的静态资源）建议设为 DIRECT：

```
DOMAIN-SUFFIX,taobao.com,DIRECT
DOMAIN-SUFFIX,tmall.com,DIRECT
DOMAIN-SUFFIX,alicdn.com,DIRECT
DOMAIN-SUFFIX,mmstat.com,DIRECT
DOMAIN-SUFFIX,cainiao.com,DIRECT
DOMAIN-SUFFIX,tbcdn.cn,DIRECT
```

其中脚本代码里明确请求的有：`h5.m.taobao.com`（H5 订单列表）、`buyertrade.taobao.com`（PC 已买到的宝贝）、`login.taobao.com`（登录/扫码）、`pages-g.m.taobao.com` 与 `m.m.taobao.com`（物流/订单详情）、`h5api.m.taobao.com`（菜鸟等 mtop 接口）。WebView 打开这些页面时还可能请求 `alicdn.com`、`mmstat.com` 等资源，一并直连更稳。

## 许可说明

请阅读 `NOTICE.md`。原包没有许可证和作者署名；部分协议实现注明来自第三方开源项目（其中含 GPL-3.0）。本仓库是在用户明确接受版权与许可风险后公开的远程更新源。

## 官方文档

- 远程脚本来源与更新（英文）：https://scriptingapp.github.io/guide/Script/Script
- 同上（中文）：https://scriptingapp.github.io/zh/guide/Script/Script
- TestFlight 英文：https://scriptingapp.github.io/TestFlight/guide/Script/Script
- TestFlight 中文：https://scriptingapp.github.io/TestFlight/zh/guide/Script/Script

（小组件/实况活动的 Remote Updates HTTP API 是另一套推送接口，与脚本远程更新不是同一件事。）
