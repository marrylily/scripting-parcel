# 包裹助手（远程更新 1.2.4）

这是 Scripting App 脚本「包裹助手」的远程更新副本，版本 **1.2.4**。公开仓库为 [`marrylily/scripting-parcel`](https://github.com/marrylily/scripting-parcel)，分支 `main`，脚本目录 `script/`。

1.2.4 在远程更新能力之外，安全包装了会在 WebView/后台回调里触发「Timer requires its active script on the main」的计时器；手动同步开始时会清掉 App Group 里的旧失败记录，新失败会带上版本号和时间。登录与密钥逻辑未改。

若要改仓库名，请同时修改：

1. 本仓库根目录的 `publish.config.json`
2. `script/script.json` 里的 `remoteResource.url`
3. 本 README 中的链接

## 目录说明

| 路径 | 作用 |
| --- | --- |
| `script/` | 给 Scripting 导入/远程更新用的脚本目录，内含 `script.json` 和入口文件 |
| `releases/包裹助手_远程更新_1.2.4.zip` | 与 `script/` 内容相同的打包 zip，便于手动导入，也可作为可直接下载的 ZIP 备用 |
| `publish.config.json` | 仓库名、分支、远程 URL 的占位配置 |
| `NOTICE.md` | 作者、许可与第三方来源说明（公开前请先阅读） |

## 在 iPhone 的 Scripting 里导入

任选一种方式：

1. **用 GitHub 地址导入（推荐，便于之后远程更新）**  
   在 Scripting 中导入脚本，地址填写：

   `https://github.com/marrylily/scripting-parcel/tree/main/script`

   官方文档把这种形式列为「某 revision 内的脚本子目录」。不要填仓库首页的网页说明，也不要填无法直接下载的 Release 展示页。

2. **用打包文件导入**  
   把 `releases/包裹助手_远程更新_1.2.4.zip` 传到手机，在 Scripting 里作为脚本包导入。

导入后会出现独立脚本「包裹助手（远程更新）」，**不会自动覆盖**原来的「包裹助手」或先前的 1.2.1 / 1.2.2 诊断包。首次使用仍按 `script/README.md`：在设置里授权你要用的平台。已有登录态在系统钥匙串里，一般不必重新登录；本版本也没有改登录或密钥逻辑。

## 远程更新如何工作

依据 Scripting 官方文档（见文末链接）：

- `script/script.json` 已填写 `remoteResource`，只包含文档列出的两个字段：
  - `url`：`https://github.com/marrylily/scripting-parcel/tree/main/script`
  - `autoUpdateInterval`：`3600`（秒，约每小时请求检查一次）
- **不要**自行编写或复制 `hash`。文档写明：`hash` 由 App 维护，不要把不完整的 `remoteResource` 拷进 `script.json`，也不要编造 hash。
- 间隔单位是秒，**实际最小为 1800 秒（30 分钟）**。更小的值会被提高到 1800。省略或设为 `null` 则关闭该脚本的定时检查。这只是调度间隔，不保证 App 挂起时仍准时执行。
- App 里还有一个**全局「自动更新」开关**：打开时，检查到更新会自动替换脚本文件；关闭时，定时检查仍可发现并标记待更新，但不会自动替换。手动检查不依赖这里的间隔。
- 文档要求保持远程 URL 稳定，并**递增 `version` 便于识别更新**。文档**没有**写「只用 version 字段判断是否有更新」；更新比对由 App 维护的 `hash` 负责。因此发新版时请改代码或资源后同时把 `script.json` 的 `version` 往上加，例如 1.2.4 → 1.2.5。
- 远程目录必须包含 `script.json` 和入口文件（本仓库是 `script/index.tsx`）。ZIP 应是可直接下载的归档；也可以有一层外包目录。不要把多个无关顶层文件夹打进同一个 ZIP。
- GitHub 链接由 App 解析，不是通用 Git/SSH 客户端。`tree` 后面第一段当作 revision，分支名不要带 `/`。
- 官方未把 `raw.githubusercontent.com` 或 GitHub Release 展示页单列为来源格式。若改用 ZIP，请用**可以直接下载文件的地址**（例如日后 Release 的 `releases/download/.../xxx.zip`），不要用 Release 网页。本仓库默认使用已文档化的 GitHub 子目录地址，不依赖 raw。

导入后，请到该脚本的设置里确认远程来源和自动更新开关与预期一致。

更新脚本时：修改 `script/` 下的文件，提高 `version`，推送到同一 `url` 指向的目录即可。不要改 URL，除非仓库搬家（搬家时同步改 `publish.config.json`、`script.json` 和本说明）。

## 与先前版本的关系

已发给真机试用的 1.2.1 / 1.2.2 诊断包，以及原先的 1.2.0、1.2.3 远程更新包，都保持不动。本脚本显示名仍是稳定的「包裹助手（远程更新）」，导入后不会自动覆盖那些旧副本。

1.2.3 主要加入远程来源。1.2.4 继续修同步路径上原包就有的 `setTimeout`（例如淘宝发现订单在 WebView `loadURL` 之后的 `pageTimeout` / `delay`），并把失败记录加上版本戳，避免把旧版残留错误和新失败混在一起。

## 许可说明

请阅读 `NOTICE.md`。原包没有许可证和作者署名；部分协议实现注明来自第三方开源项目（其中含 GPL-3.0）。本仓库是在用户明确接受版权与许可风险后公开的远程更新源。

## 官方文档

- 远程脚本来源与更新（英文）：https://scriptingapp.github.io/guide/Script/Script
- 同上（中文）：https://scriptingapp.github.io/zh/guide/Script/Script
- TestFlight 英文：https://scriptingapp.github.io/TestFlight/guide/Script/Script
- TestFlight 中文：https://scriptingapp.github.io/TestFlight/zh/guide/Script/Script

（小组件/实况活动的 Remote Updates HTTP API 是另一套推送接口，与脚本远程更新不是同一件事。）
