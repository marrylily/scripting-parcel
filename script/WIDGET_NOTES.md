# 小组件架构与约束（2026-11-15 更新）

## 运行顺序（不可调换）

1. 读共享快照 `cc/widget.json`，叠加 `cc/ops/picked` 事件
2. `Widget.present(...)` —— 首帧只画缓存数据，**前面不允许任何 await**
3. 写 `cc/widgetPresent.log`（真机排查用）
4. `await backgroundSync()` —— 只做联网，预算见下表（总 18s / 单平台 18s / 轻量 8s，外层 race 24s）
5. `Script.exit()`

证据：`cc/perf.log` 里 `presented` 时间必须早于 `bg …ms`。把联网挪到 present 之前会灰屏。

## 数据归属

- 快照：App `store.writeWidgetSnapshot()` 写，组件只读；**不写 Keychain 凭据**
- 已取：组件 AppIntent 写 `cc/ops/picked/<id>.json`（单操作单文件），App 落库后删除
- 新包裹：`cc/ops/new/*.json`；物流：`cc/ops/track/*.json`；同样逐条确认
- 调度状态：`cc/widgetTasks.json`；锁 `cc/widgetTasks.lock` 带 token，迟到任务不能删别人的锁

## 硬约束

- 卡片只有一份实现：`ui/parcelCard.tsx`。组件复用，但该文件不能 import `store`（会把 Storage/网络拖进扩展）
- `theme.ts` 的 `UIGlass` 必须是 getter：扩展里没有 `UIGlass`
- 图标：共享目录优先，工程资源兜底；取不到返回 `null`，不画占位白框
- 组件不读 App 私有 Storage；设置一律从快照 `settings` 读
- 后台联网开关 `bgRefresh=false` 时只出图，不联网（灵动岛到期检查仍执行）

## 预算（2026-11-18 实测后确定）

| 项 | 值 |
|---|---|
| 全量总预算 `FULL_BUDGET_MS` | 18s |
| 单平台 `PER_PLATFORM_MS` | 18s（第一个平台能用满，第二个只拿剩余） |
| 轻量刷新 `LIGHT_BUDGET_MS` | 8s |
| 外层 race | 24s（留 ~6s 给新单合并落盘） |
| 调度锁 `LOCK_MS` | 25s（被系统杀掉也不会堵住下一次唤醒） |
| 一次唤醒最多平台数 | 2（实际常为 1） |

实测量级（App 内，deadline=18s）：菜鸟 0.41s、丰巢 0.33s、拼多多 1.15s、淘宝 5.25s、得物 8.45s、**京东 12 单 23.6s**。
因此组件里京东用 `maxTargets: 3`（`Script.env === "widget"` 时由 platformSync 传入），其余单下次从指针续跑。

## 已知限制

- 组件**会**做全量发现：`runWidgetTasks` 每次唤醒按“最旧优先”排队，单平台预算 18s；超时的平台记一次连败，退避 30min×n，3 次后停 6h 交回 App
- 扩展能活多久由系统决定：实测 ≥10s 打点正常、得物 8.9s 任务能跑完；18s 整轮尚未测到完整样本，`cc/perf.log` 里出现只有 `bgStart` 没有 `bg …ms` 就是被系统收走了
- 系统可能合并/延迟 timeline 重建；`reloadPolicy` 只是建议
- 组件只能在 WidgetKit 唤起的执行窗口内工作，不支持常驻后台

## 版本

当前 `WIDGET_VERSION = 1.2.1-w5`（以 `widgetVersion.ts` 为准），只用于日志与首帧判定，**页脚不再显示版本号**。改组件代码必须同时改版本号。
