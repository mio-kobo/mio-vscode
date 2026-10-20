# 迁移记录

来源：ExMikuPro/Mio 的 Mio-2，提交 29746a65692c73d637510cbc3f4463e68a49d05c。
使用 git-filter-repo 提取 editors/vscode/，过滤后的 SHA 会变化；提交映射保存在本地迁移备份中。核心标签未迁入，未创建版本标签或 Release。

Marketplace 身份保持不变。CI 可手动运行作为构建 Dry Run。真实发布默认关闭：须先完成 CI、Environment 和凭据配置，再经人工审核设置仓库变量 MARKETPLACE_ENABLED=true。
发布历史守卫使用 main，标签格式保持 vscode-V<version>。原 Marketplace 版本记录继续以原市场页面为准，不伪造迁移标签。

代码采用 MIT；历史中的角色宣传图和插件图标不能从代码许可证推断授权。沿用原素材授权说明；在新增对外分发前需核实素材权利。
