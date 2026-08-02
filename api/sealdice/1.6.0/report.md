# SealDice 1.6.0 API Inventory

- Core commit: `b06a2d92a7af0b8b33be33390206297edf29c7bd`
- Distribution runtime: `1.6.0+20260726`
- Source declaration: `1.5.1-dev`
- Source fingerprint: `sha256:e508cb9d4bd008f98e08c6e8e853df7d97ffa7e34d06c305053d3eb310a230f0`
- Scanner version: `2`
- Inventory digest: `sha256:e0530ce889b7b0d969de65538678077bc2fe15dedfa017ff078652c9616929f2`
- Semantic override digest: `sha256:bae9dd0b2ff825c104a7116028f900b5713fc2495e34114e1c31c7967d8fd975`

| Path | Kind | Go signature | Source |
| --- | --- | --- | --- |
| `seal.applyPlayerGroupCardByTemplate` | function | `func(*MsgContext, string) string` | `dice/dice_jsvm.go:557` |
| `seal.ban` | object |  | `dice/dice_jsvm.go:134` |
| `seal.ban.addBan` | function | `func(*MsgContext, string, string, string)` | `dice/dice_jsvm.go:135` |
| `seal.ban.addTrust` | function | `func(*MsgContext, string, string, string)` | `dice/dice_jsvm.go:139` |
| `seal.ban.getList` | function | `func() []BanListInfoItem` | `dice/dice_jsvm.go:150` |
| `seal.ban.getUser` | function | `func(string) *BanListInfoItem` | `dice/dice_jsvm.go:158` |
| `seal.ban.remove` | function | `func(*MsgContext, string)` | `dice/dice_jsvm.go:143` |
| `seal.base64ToImage` | function | `func(string) (string, error)` | `dice/dice_jsvm.go:631` |
| `seal.coc` | object |  | `dice/dice_jsvm.go:523` |
| `seal.coc.newRule` | function | `func() *CocRuleInfo` | `dice/dice_jsvm.go:514` |
| `seal.coc.newRuleCheckResult` | function | `func() *CocRuleCheckRet` | `dice/dice_jsvm.go:517` |
| `seal.coc.registerRule` | function | `func(*CocRuleInfo) bool` | `dice/dice_jsvm.go:520` |
| `seal.createTempCtx` | function | `func(*EndPointInfo, *Message) *MsgContext` | `dice/dice_jsvm.go:556` |
| `seal.deck` | object |  | `dice/dice_jsvm.go:541` |
| `seal.deck.draw` | function | `func(*MsgContext, string, bool) map[string]interface{}` | `dice/dice_jsvm.go:526` |
| `seal.deck.reload` | function | `func()` | `dice/dice_jsvm.go:538` |
| `seal.ext` | object |  | `dice/dice_jsvm.go:168` |
| `seal.ext.find` | function | `func(string) *ExtInfo` | `dice/dice_jsvm.go:195` |
| `seal.ext.getBoolConfig` | function | `func(*ExtInfo, string) bool` | `dice/dice_jsvm.go:384` |
| `seal.ext.getConfig` | function | `func(*ExtInfo, string) *ConfigItem` | `dice/dice_jsvm.go:366` |
| `seal.ext.getFloatConfig` | function | `func(*ExtInfo, string) float64` | `dice/dice_jsvm.go:390` |
| `seal.ext.getIntConfig` | function | `func(*ExtInfo, string) int64` | `dice/dice_jsvm.go:378` |
| `seal.ext.getOptionConfig` | function | `func(*ExtInfo, string) string` | `dice/dice_jsvm.go:402` |
| `seal.ext.getStringConfig` | function | `func(*ExtInfo, string) string` | `dice/dice_jsvm.go:372` |
| `seal.ext.getTemplateConfig` | function | `func(*ExtInfo, string) []string` | `dice/dice_jsvm.go:396` |
| `seal.ext.new` | function | `func(string, string, string) *ExtInfo` | `dice/dice_jsvm.go:178` |
| `seal.ext.newCmdExecuteResult` | function | `func(bool) CmdExecuteResult` | `dice/dice_jsvm.go:172` |
| `seal.ext.newCmdItemInfo` | function | `func() *CmdItemInfo` | `dice/dice_jsvm.go:169` |
| `seal.ext.newConfigItem` | function | `func(*ExtInfo, string, interface{}, string) *ConfigItem` | `dice/dice_jsvm.go:353` |
| `seal.ext.register` | function | `func(*ExtInfo)` | `dice/dice_jsvm.go:198` |
| `seal.ext.registerBoolConfig` | function | `func(*ExtInfo, string, bool, string, string) error` | `dice/dice_jsvm.go:292` |
| `seal.ext.registerConfig` | function | `func(*ExtInfo, ...*ConfigItem) error` | `dice/dice_jsvm.go:359` |
| `seal.ext.registerFloatConfig` | function | `func(*ExtInfo, string, float64, string, string) error` | `dice/dice_jsvm.go:307` |
| `seal.ext.registerIntConfig` | function | `func(*ExtInfo, string, int64, string, string) error` | `dice/dice_jsvm.go:277` |
| `seal.ext.registerOptionConfig` | function | `func(*ExtInfo, string, string, []string, string, string) error` | `dice/dice_jsvm.go:337` |
| `seal.ext.registerStringConfig` | function | `func(*ExtInfo, string, string, string, string) error` | `dice/dice_jsvm.go:262` |
| `seal.ext.registerTask` | function | `func(*ExtInfo, string, string, func(taskCtx JsScriptTaskCtx), string, string, string) *JsScriptTask` | `dice/dice_jsvm.go:415` |
| `seal.ext.registerTemplateConfig` | function | `func(*ExtInfo, string, []string, string, string) error` | `dice/dice_jsvm.go:322` |
| `seal.ext.unregisterConfig` | function | `func(*ExtInfo, ...string)` | `dice/dice_jsvm.go:408` |
| `seal.format` | function | `func(*MsgContext, string) string` | `dice/dice_jsvm.go:548` |
| `seal.formatTmpl` | function | `func(*MsgContext, string) string` | `dice/dice_jsvm.go:549` |
| `seal.gameSystem` | object |  | `dice/dice_jsvm.go:590` |
| `seal.gameSystem.newTemplate` | function | `func(string) error` | `dice/dice_jsvm.go:568` |
| `seal.gameSystem.newTemplateByYaml` | function | `func(string) error` | `dice/dice_jsvm.go:579` |
| `seal.getCtxProxyAtPos` | function | `func(*MsgContext, *CmdArgs, int) *MsgContext` | `dice/dice_jsvm.go:591` |
| `seal.getCtxProxyFirst` | function | `func(*MsgContext, *CmdArgs) *MsgContext` | `dice/dice_jsvm.go:550` |
| `seal.getEndPoints` | function | `func() []*EndPointInfo` | `dice/dice_jsvm.go:606` |
| `seal.getVersion` | function | `func() map[string]interface{}` | `dice/dice_jsvm.go:592` |
| `seal.memberBan` | function | `func(*MsgContext, string, string, int64)` | `dice/dice_jsvm.go:546` |
| `seal.memberKick` | function | `func(*MsgContext, string, string)` | `dice/dice_jsvm.go:547` |
| `seal.newMessage` | function | `func() *Message` | `dice/dice_jsvm.go:553` |
| `seal.replyGroup` | function | `func(*MsgContext, *Message, string)` | `dice/dice_jsvm.go:543` |
| `seal.replyPerson` | function | `func(*MsgContext, *Message, string)` | `dice/dice_jsvm.go:544` |
| `seal.replyToSender` | function | `func(*MsgContext, *Message, string)` | `dice/dice_jsvm.go:545` |
| `seal.setPlayerGroupCard` | function | `func(*MsgContext, string) (string, error)` | `dice/dice_jsvm.go:630` |
| `seal.vars` | object |  | `dice/dice_jsvm.go:125` |
| `seal.vars.computedGet` | function | `func(*MsgContext, string) (string, bool)` | `dice/dice_jsvm.go:131` |
| `seal.vars.computedSet` | function | `func(*MsgContext, string, string)` | `dice/dice_jsvm.go:130` |
| `seal.vars.intGet` | function | `func(*MsgContext, string) (int64, bool)` | `dice/dice_jsvm.go:126` |
| `seal.vars.intSet` | function | `func(*MsgContext, string, int64)` | `dice/dice_jsvm.go:127` |
| `seal.vars.strGet` | function | `func(*MsgContext, string) (string, bool)` | `dice/dice_jsvm.go:128` |
| `seal.vars.strSet` | function | `func(*MsgContext, string, string)` | `dice/dice_jsvm.go:129` |
