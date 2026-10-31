# Changelog

## [0.1.1](https://github.com/rigomart/wt-dash/compare/v0.1.0...v0.1.1) (2026-10-31)


### Bug Fixes

* keep size measurements current and batch cache writes ([#66](https://github.com/rigomart/wt-dash/issues/66)) ([1c0055f](https://github.com/rigomart/wt-dash/commit/1c0055f72fd4707ebc2d170fa7c214f2a9fe371a))
* load focused file details during background updates ([#65](https://github.com/rigomart/wt-dash/issues/65)) ([2dab27f](https://github.com/rigomart/wt-dash/commit/2dab27f53f9c4d72e02d0e2ea2042b8650a1aa39))
* preserve newer previews after cancelled checks ([#63](https://github.com/rigomart/wt-dash/issues/63)) ([e211b03](https://github.com/rigomart/wt-dash/commit/e211b03c0f99aed9cb66359d70336a0c57bbbe31))


### Performance Improvements

* bound Git reference lookups during removal ([#68](https://github.com/rigomart/wt-dash/issues/68)) ([2ea41e0](https://github.com/rigomart/wt-dash/commit/2ea41e0f793404a7586a8d72c86c3455115c7726))

## 0.1.0 (2026-10-30)


### Features

* find and remove orphaned worktree folders ([#48](https://github.com/rigomart/wt-dash/issues/48)) ([d395880](https://github.com/rigomart/wt-dash/commit/d39588045e1af8ac50faf1e4f911a4dfb626e096)), closes [#41](https://github.com/rigomart/wt-dash/issues/41)
* find repositories on the first run without folders ([#53](https://github.com/rigomart/wt-dash/issues/53)) ([e079835](https://github.com/rigomart/wt-dash/commit/e0798352cdc45b156e71271fd51a607d55fd2a74)), closes [#42](https://github.com/rigomart/wt-dash/issues/42)
* guard worktrees agents are using and list leftover branches ([#18](https://github.com/rigomart/wt-dash/issues/18)) ([ef4f26e](https://github.com/rigomart/wt-dash/commit/ef4f26e8dc730a71d880f5406004290c89f0c51b))
* initial release of wt-dash ([e184b1e](https://github.com/rigomart/wt-dash/commit/e184b1e4ec40770c3914d0664710a0ee4974e409))
* name ignored files that aren't caches in the remove dialog ([#49](https://github.com/rigomart/wt-dash/issues/49)) ([b6940c6](https://github.com/rigomart/wt-dash/commit/b6940c6bd8e39aca4dc5d4128b39e89aa280a007)), closes [#45](https://github.com/rigomart/wt-dash/issues/45)
* open on a projects screen with fixed details and status lines ([#8](https://github.com/rigomart/wt-dash/issues/8)) ([906247f](https://github.com/rigomart/wt-dash/commit/906247f199ed54ca8b5edc2fd70f3b34626a4523))
* recognize current t3 worktrees and more agent tools ([#46](https://github.com/rigomart/wt-dash/issues/46)) ([fd692c7](https://github.com/rigomart/wt-dash/commit/fd692c713b56705766710a98d37fea3784359ddf)), closes [#43](https://github.com/rigomart/wt-dash/issues/43)
* remember the repositories wt-dash finds between runs ([#60](https://github.com/rigomart/wt-dash/issues/60)) ([ad71c1a](https://github.com/rigomart/wt-dash/commit/ad71c1a1af5b9aaf042301d79ddd7d5da64841a2)), closes [#50](https://github.com/rigomart/wt-dash/issues/50)
* show projects in a sidebar beside the worktree list ([#9](https://github.com/rigomart/wt-dash/issues/9)) ([cf9a8f6](https://github.com/rigomart/wt-dash/commit/cf9a8f6d76e7bd9bc2211d8ae489b650f2b1dd6c))
* show the processes and ports running in each worktree ([#51](https://github.com/rigomart/wt-dash/issues/51)) ([c20a2e9](https://github.com/rigomart/wt-dash/commit/c20a2e9c33dd170f1ffadf113ab11d170ff32453)), closes [#44](https://github.com/rigomart/wt-dash/issues/44)
* show what a branch holds and its notes in the details ([#39](https://github.com/rigomart/wt-dash/issues/39)) ([8b58cab](https://github.com/rigomart/wt-dash/commit/8b58cab1188b901cd5f6f1613765f6b24fcc8812))
* support Linux on arm64 and x64 ([#17](https://github.com/rigomart/wt-dash/issues/17)) ([b98d72a](https://github.com/rigomart/wt-dash/commit/b98d72a7962c728a5dc0f7f9e2bf092da9445a15))


### Bug Fixes

* accept every Worktrunk release format and follow a light terminal theme ([#59](https://github.com/rigomart/wt-dash/issues/59)) ([da8afa2](https://github.com/rigomart/wt-dash/commit/da8afa210c43f89ae516b21d145be85f981e9c8f))
* count a worktree as sizing only while its size is being measured ([#38](https://github.com/rigomart/wt-dash/issues/38)) ([4ff76cf](https://github.com/rigomart/wt-dash/commit/4ff76cfbc4cc461147ef058514f2ab4735d2762c)), closes [#24](https://github.com/rigomart/wt-dash/issues/24)
* keep a size measured during the full listing on screen ([#26](https://github.com/rigomart/wt-dash/issues/26)) ([c245866](https://github.com/rigomart/wt-dash/commit/c24586655458b80453ac9cb17cb5a45cfcf4a655))
* keep fresh worktrees with no new commits out of Safe ([#16](https://github.com/rigomart/wt-dash/issues/16)) ([d6ae442](https://github.com/rigomart/wt-dash/commit/d6ae442347dc80c230a0138f831ffb1c282acd45))
* make the dialogs' confirm button readable in dark and light terminals ([#61](https://github.com/rigomart/wt-dash/issues/61)) ([6b4bc4a](https://github.com/rigomart/wt-dash/commit/6b4bc4ab9f54d67941cc23df7c5c87e822eec6de)), closes [#58](https://github.com/rigomart/wt-dash/issues/58)
* preview a branch main moved past as deleted ([#37](https://github.com/rigomart/wt-dash/issues/37)) ([53d2edb](https://github.com/rigomart/wt-dash/commit/53d2edb59534abbfb7c2afbe9a4f8785f1a3c962)), closes [#23](https://github.com/rigomart/wt-dash/issues/23)
* show sizes in the remove dialog and stop processes inside by default ([#21](https://github.com/rigomart/wt-dash/issues/21)) ([2a58c35](https://github.com/rigomart/wt-dash/commit/2a58c35995ffd9c493282daa241a15552df1df88))
* skip a worktree recreated at the same path during a removal batch ([#36](https://github.com/rigomart/wt-dash/issues/36)) ([604a9a1](https://github.com/rigomart/wt-dash/commit/604a9a133d60e739946e41ed380813ee22ebddbe)), closes [#22](https://github.com/rigomart/wt-dash/issues/22)


### Performance Improvements

* list each repo once per removal batch and check worktrees locally ([#6](https://github.com/rigomart/wt-dash/issues/6)) ([b677be6](https://github.com/rigomart/wt-dash/commit/b677be682f060a2e81706ea4b2affedfaa139a2b))
* list worktrees before leftover branches on a cold scan ([#20](https://github.com/rigomart/wt-dash/issues/20)) ([c5c022b](https://github.com/rigomart/wt-dash/commit/c5c022b40838c19244863b904cc644fd8669d9f2))
* measure sizes six at a time and list each repo once per removal preview ([#2](https://github.com/rigomart/wt-dash/issues/2)) ([d719877](https://github.com/rigomart/wt-dash/commit/d7198775b2151cdc25c68270246e47e2a31ab9fa))
* re-measure worktree sizes only when they are out of date ([#3](https://github.com/rigomart/wt-dash/issues/3)) ([69de2ee](https://github.com/rigomart/wt-dash/commit/69de2ee6400e0a25889a70203a6b213076f177e4))
