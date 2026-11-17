# 包裹助手（远程更新 1.2.3）

这是 Scripting App 脚本「包裹助手」的发布准备副本，版本 **1.2.3**。它在 1.2.2 诊断修复版（同步错误可见、手动同步菜鸟先行、不再增加不兼容的硬超时计时器）之上，加入了官方支持的远程来源字段，方便之后从 GitHub 检查更新。

**当前还没有创建或推送 GitHub 仓库。** 下面的地址是占位，仓库公开并推送后才会生效。

暂定仓库：`marrylily/scripting-parcel`，分支 `main`，脚本目录 `script/`。若要改名，请同时修改：

1. 本仓库根目录的 `publish.config.json`
2. `script/script.json` 里的 `remoteResource.url`
3. 本 README 中的链接

## 目录说明

| 路径 | 作用 |
| --- | --- |
| `script/` | 给 Scripting 导入/远程更新用的脚本目录，内含 `script.json` 和入口文件 |
| `releases/包裹助手_远程更新_1.2.3.zip` | 与 `script/` 内容相同的打包 zip，便于手动导入，也可作为可直接下载的 ZIP 备用 |
| `publish.config.json` | 仓库名、分支、远程 URL 的占位配置 |
| `NOTICE.md` | 作者、许可与第三方来源说明（公开前请先阅读） |

## 在 iPhone 的 Scripting 里导入

仓库公开后，任选一种方式：

1. **用 GitHub 地址导入（推荐，便于之后远程更新）**  
   在 Scripting 中导入脚本，地址填写：

   `https://github.com/marrylily/scripting-parcel/tree/main/script`

   官方文档把这种形式列为「某 revision 内的脚本子目录」。不要填仓库首页的网页说明，也不要填无法直接下载的 Release 展示页。

2. **用打包文件导入**  
   把 `releases/包裹助手_远程更新_1.2.3.zip` 传到手机，在 Scripting 里作为脚本包导入。

导入后会出现独立脚本「包裹助手（远程更新）」，**不会自动覆盖**原来的「包裹助手」或先前的 1.2.1 / 1.2.2 诊断包。首次使用仍按 `script/README.md`：在设置里授权你要用的平台。已有登录态在系统钥匙串里，一般不必重新登录；本版本也没有改登录或密钥逻辑。

## 远程更新如何工作

依据 Scripting 官方文档（见文末链接）：

- `script/script.json` 已填写 `remoteResource`，只包含文档列出的两个字段：
  - `url`：`https://github.com/marrylily/scripting-parcel/tree/main/script`
  - `autoUpdateInterval`：`3600`（秒，约每小时请求检查一次）
- **不要**自行编写或复制 `hash`。文档写明：`hash` 由 App 维护，不要把不完整的 `remoteResource` 拷进 `script.json`，也不要编造 hash。
- 间隔单位是秒，**实际最小为 1800 秒（30 分钟）**。更小的值会被提高到 1800。省略或设为 `null` 则关闭该脚本的定时检查。这只是调度间隔，不保证 App 挂起时仍准时执行。
- App 里还有一个**全局「自动更新」开关**：打开时，检查到更新会自动替换脚本文件；关闭时，定时检查仍可发现并标记待更新，但不会自动替换。手动检查不依赖这里的间隔。
- 文档要求保持远程 URL 稳定，并**递增 `version` 便于识别更新**。文档**没有**写「只用 version 字段判断是否有更新」；更新比对由 App 维护的 `hash` 负责。因此发新版时请改代码或资源后同时把 `script.json` 的 `version` 往上加，例如 1.2.3 → 1.2.4。
- 远程目录必须包含 `script.json` 和入口文件（本仓库是 `script/index.tsx`）。ZIP 应是可直接下载的归档；也可以有一层外包目录。不要把多个无关顶层文件夹打进同一个 ZIP。
- GitHub 链接由 App 解析，不是通用 Git/SSH 客户端。`tree` 后面第一段当作 revision，分支名不要带 `/`。
- 官方未把 `raw.githubusercontent.com` 或 GitHub Release 展示页单列为来源格式。若改用 ZIP，请用**可以直接下载文件的地址**（例如日后 Release 的 `releases/download/.../xxx.zip`），不要用 Release 网页。本仓库默认使用已文档化的 GitHub 子目录地址，不依赖 raw。

导入后，请到该脚本的设置里确认远程来源和自动更新开关与预期一致。

更新脚本时：修改 `script/` 下的文件，提高 `version`，推送到同一 `url` 指向的目录即可。不要改 URL，除非仓库搬家（搬家时同步改 `publish.config.json`、`script.json` 和本说明）。

## 与 1.2.2 的关系

已发给真机试用的 1.2.2 诊断包保持不动。1.2.3 是它的发布准备副本：同步行为与 1.2.2 相同，只增加远程来源配置，并把显示名改为稳定的「包裹助手（远程更新）」，避免以后升版本时脚本名跟着变。

## 公开前请先看

请先阅读 `NOTICE.md`。原包没有许可证和作者署名；部分协议实现注明来自第三方开源项目（其中含 GPL-3.0）。在原作者授权和许可问题理清之前，**不建议把本目录直接公开到 GitHub**。

## 官方文档

- 远程脚本来源与更新（英文）：https://scriptingapp.github.io/guide/Script/Script
- 同上（中文）：https://scriptingapp.github.io/zh/guide/Script/Script
- TestFlight 英文：https://scriptingapp.github.io/TestFlight/guide/Script/Script
- TestFlight 中文：https://scriptingapp.github.io/TestFlight/zh/guide/Script/Script

（小组件/实况活动的 Remote Updates HTTP API 是另一套推送接口，与脚本远程更新不是同一件事。）
