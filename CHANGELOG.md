# Changelog

## [1.21.1](https://github.com/escalay/api-kit/compare/v1.21.0...v1.21.1) (2026-11-14)


### Fixed

* **switches:** the disabled notice names no page of its own ([#59](https://github.com/escalay/api-kit/issues/59)) ([3252375](https://github.com/escalay/api-kit/commit/325237512d8aac6ca45536c918d4638f89165ba9))

## [1.21.0](https://github.com/escalay/api-kit/compare/v1.20.1...v1.21.0) (2026-11-14)


### New

* **switches:** switched-off setup steps, a panel that picks its features, the app preset asking the switches ([#57](https://github.com/escalay/api-kit/issues/57)) ([2aed829](https://github.com/escalay/api-kit/commit/2aed829ba3fe511f8393a2d30b5464bc48be7451))

## [1.20.1](https://github.com/escalay/api-kit/compare/v1.20.0...v1.20.1) (2026-11-14)


### Fixed

* **switches:** other people's switches only to owners, a feature's middleware only while on ([#55](https://github.com/escalay/api-kit/issues/55)) ([1643b58](https://github.com/escalay/api-kit/commit/1643b58ae424bd056607e1102ad8744d4adde434))

## [1.20.0](https://github.com/escalay/api-kit/compare/v1.19.0...v1.20.0) (2026-11-14)


### New

* switches, feature switches with a React client and license keys for paid features ([#53](https://github.com/escalay/api-kit/issues/53)) ([8a70574](https://github.com/escalay/api-kit/commit/8a705744a21fa27bd772bcd3f119b738cf6846a9))

## [1.19.0](https://github.com/escalay/api-kit/compare/v1.18.0...v1.19.0) (2026-11-13)


### New

* kit button, the Deploy to Cloudflare button for any app, checked and proven ([#51](https://github.com/escalay/api-kit/issues/51)) ([f85b8a8](https://github.com/escalay/api-kit/commit/f85b8a8a136d5ebae8f3deb36af1b0cb012c3f44))

## [1.18.0](https://github.com/escalay/api-kit/compare/v1.17.0...v1.18.0) (2026-11-13)


### New

* new apps refuse a feature that names Cloudflare ([#49](https://github.com/escalay/api-kit/issues/49)) ([165332f](https://github.com/escalay/api-kit/commit/165332fcca60d588b8ea95adbc607c3610cc7082))

## [1.17.0](https://github.com/escalay/api-kit/compare/v1.16.1...v1.17.0) (2026-11-13)


### New

* new apps scan their code and dependencies once public ([#47](https://github.com/escalay/api-kit/issues/47)) ([9d9302d](https://github.com/escalay/api-kit/commit/9d9302d778446a82f1143f9405ca3a2cea534620))
* **repo:** require the checks a called reusable workflow reports ([#45](https://github.com/escalay/api-kit/issues/45)) ([6466252](https://github.com/escalay/api-kit/commit/6466252aab018c1e4f155be2d3298853be7bb391))
* run the shared workflows from escalay/.github in CI ([ba1fbfe](https://github.com/escalay/api-kit/commit/ba1fbfe364787e75962b6a39ad05737531473e4b))

## [1.16.1](https://github.com/escalay/api-kit/compare/v1.16.0...v1.16.1) (2026-11-13)


### Fixed

* **repo:** leave auto-merge out on a repository that can't have rules ([#42](https://github.com/escalay/api-kit/issues/42)) ([e22f843](https://github.com/escalay/api-kit/commit/e22f843e3de5ad9a04872a5769b6ff0d693f6274))


### Documentation

* name the canaries and what to do when one fails ([#44](https://github.com/escalay/api-kit/issues/44)) ([873940a](https://github.com/escalay/api-kit/commit/873940ad99f4726fa3342cc89e272e84be45f86d))

## [1.16.0](https://github.com/escalay/api-kit/compare/v1.15.3...v1.16.0) (2026-11-13)


### New

* kit repo check|apply sets a GitHub repository up as the standard says ([#41](https://github.com/escalay/api-kit/issues/41)) ([4359346](https://github.com/escalay/api-kit/commit/4359346d8f2505810b9de79c1ece093b582b21a8))
* pnpm gate and a pre-push hook in every new app, the same checks as CI ([#38](https://github.com/escalay/api-kit/issues/38)) ([6157a59](https://github.com/escalay/api-kit/commit/6157a59dd3ed732b9f9c493f88c98d380b39e5bb))


### Documentation

* say how changes ship, in every new app and in the standard ([#40](https://github.com/escalay/api-kit/issues/40)) ([becf43e](https://github.com/escalay/api-kit/commit/becf43e301c7a62cf4db6f1a424c0ffccb2506ee))

## [1.15.3](https://github.com/escalay/api-kit/compare/v1.15.2...v1.15.3) (2026-11-13)


### Fixed

* **init:** pin pnpm in new apps from the published package too ([#36](https://github.com/escalay/api-kit/issues/36)) ([87121d5](https://github.com/escalay/api-kit/commit/87121d518a27bf4ea72d1dee21ed314c84e1b3a2))

## [1.15.2](https://github.com/escalay/api-kit/compare/v1.15.1...v1.15.2) (2026-11-13)


### Fixed

* **init:** pin the kit's pnpm in every new app ([#34](https://github.com/escalay/api-kit/issues/34)) ([7c73d88](https://github.com/escalay/api-kit/commit/7c73d88fa7295e49443d3a3b9333131112789c6f))

## [1.15.1](https://github.com/escalay/api-kit/compare/v1.15.0...v1.15.1) (2026-11-13)


### Fixed

* **release:** release pull requests auto-merge, and a tag can be published by hand ([#32](https://github.com/escalay/api-kit/issues/32)) ([3c3b6fa](https://github.com/escalay/api-kit/commit/3c3b6fabf10cfd647602ed8ba88866240569f3e5))

## [1.15.0](https://github.com/escalay/api-kit/compare/v1.14.1...v1.15.0) (2026-11-13)


### New

* every new app starts with CI, Dependabot and a secrets scan ([#31](https://github.com/escalay/api-kit/issues/31)) ([faf2a5d](https://github.com/escalay/api-kit/commit/faf2a5d857e4be2e0b6e6da7b149a34c84c8b8c4))


### Fixed

* **deps:** new apps start on the latest versions, tested on Node 26 ([#29](https://github.com/escalay/api-kit/issues/29)) ([4a3c1d2](https://github.com/escalay/api-kit/commit/4a3c1d2e38ab287c79e913f07a179ce3ac44eb44))

## [1.14.1](https://github.com/escalay/api-kit/compare/v1.14.0...v1.14.1) (2026-11-13)


### Fixed

* skills findable over MCP, and sign-in failures name the command ([#21](https://github.com/escalay/api-kit/issues/21)) ([c2103da](https://github.com/escalay/api-kit/commit/c2103daae06898d9c0b574d22bbb3df24c2cf73b))

## [1.14.0](https://github.com/escalay/api-kit/compare/v1.13.0...v1.14.0) (2026-11-13)


### New

* every app's mcp tools as a command line ([#19](https://github.com/escalay/api-kit/issues/19)) ([1d1b558](https://github.com/escalay/api-kit/commit/1d1b558b95a6753d8216397d4b5494d9d627a2e9))

## [1.13.0](https://github.com/escalay/api-kit/compare/v1.12.1...v1.13.0) (2026-11-13)


### New

* device codes, refresh tokens for claimed agents, and the telemetry part ([#18](https://github.com/escalay/api-kit/issues/18)) ([6f35242](https://github.com/escalay/api-kit/commit/6f35242532391184780ed7582bfc567ade4961f3))
* people and setup parts (passkey sign-in, claiming a deployment, the team) ([#16](https://github.com/escalay/api-kit/issues/16)) ([d5a6d58](https://github.com/escalay/api-kit/commit/d5a6d583b1a5f8b9a2b00ee0385c7a51b8e2bddd))

## [1.12.1](https://github.com/escalay/api-kit/compare/v1.12.0...v1.12.1) (2026-11-12)


### Fixed

* **keys:** examples start like the app's keys, and say every key sees everything ([#14](https://github.com/escalay/api-kit/issues/14)) ([862f97d](https://github.com/escalay/api-kit/commit/862f97dc70bd9faa431f7be916e109529f9481fe))

## [1.12.0](https://github.com/escalay/api-kit/compare/v1.11.0...v1.12.0) (2026-11-12)


### New

* keys, kit sdk, deploy:env and core parts lifted from mailroom ([#12](https://github.com/escalay/api-kit/issues/12)) ([f5770df](https://github.com/escalay/api-kit/commit/f5770dfc93f6a7fcb2f2e9b97a718e7c383e0588))

## [1.11.0](https://github.com/escalay/api-kit/compare/v1.10.1...v1.11.0) (2026-11-12)


### New

* take api keys the app stores itself through storedKeys ([#10](https://github.com/escalay/api-kit/issues/10)) ([199a941](https://github.com/escalay/api-kit/commit/199a9413b7a06c992ec40c6f73bdec8e3b32138b))

## [1.10.1](https://github.com/escalay/api-kit/compare/v1.10.0...v1.10.1) (2026-11-12)


### Fixed

* installing from a repository offers the product's skill, not the developer ones ([#8](https://github.com/escalay/api-kit/issues/8)) ([d20f2f1](https://github.com/escalay/api-kit/commit/d20f2f1d81f801ae85d16f4098ca3b5f108f951e))

## [1.10.0](https://github.com/escalay/api-kit/compare/v1.9.0...v1.10.0) (2026-11-12)


### New

* every app ships its own skills, served over MCP and installable ([#6](https://github.com/escalay/api-kit/issues/6)) ([e1a188a](https://github.com/escalay/api-kit/commit/e1a188ae95521c8a797a05ca8e86fdf94aa164b3))

## [1.9.0](https://github.com/escalay/api-kit/compare/v1.8.0...v1.9.0) (2026-11-12)


### New

* add the app preset, and oxlint and oxfmt for every new app ([#5](https://github.com/escalay/api-kit/issues/5)) ([0d3928a](https://github.com/escalay/api-kit/commit/0d3928a198df85acc810e040401f6c0430fb576e))


### Fixed

* stamp new Workers apps with a date the pinned runtime accepts ([#3](https://github.com/escalay/api-kit/issues/3)) ([174b3cf](https://github.com/escalay/api-kit/commit/174b3cf62019731cd9514358526daa21357d89c8))

## [1.8.0](https://github.com/escalay/api-kit/compare/v1.7.0...v1.8.0) (2026-11-11)


### New

* add npm-release, the release setup any repo installs with shadcn ([9a78bf5](https://github.com/escalay/api-kit/commit/9a78bf5b08fcad6724663c2a15380a5a97739ecd))
* add release:check for versions, tarballs and the npm publisher ([f251e12](https://github.com/escalay/api-kit/commit/f251e1225a23e06cc5a3b1f1baa7caf87d973df8))


### Documentation

* add the npm-release skill for setting up and running releases ([3057d5f](https://github.com/escalay/api-kit/commit/3057d5f60f6fb2cc0950361dcb14f0da29123dcc))
* describe the release cycle, its setup and what to do when it fails ([e848c68](https://github.com/escalay/api-kit/commit/e848c68318604616c255e16c76267936547ccba2))
