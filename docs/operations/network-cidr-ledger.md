# ネットワーク CIDR 台帳

AWS アカウント（ap-northeast-1）内のプロジェクト横断の VPC CIDR 割り当て台帳。
idp-golden-path の CIDR 管理方針は [ADR 0009](../adr/0009-production-deployment-on-ecs-fargate.md) を参照。

## 割り当て一覧

| CIDR | 利用者 | 管理方式 | 備考 |
| --- | --- | --- | --- |
| `10.0.0.0/16` | ticket-c2c-platform (dev) | 各リポジトリの Terraform 直書き | terraform-hannibal と**重複**（既知） |
| `10.0.0.0/16` | terraform-hannibal | 各リポジトリの Terraform 直書き | ticket-c2c-platform (dev) と**重複**（既知） |
| `10.16.0.0/12` | idp-golden-path 用 IPAM プール | VPC IPAM（`terraform/shared/`） | この範囲から VPC CIDR を払い出す |
| `10.16.0.0/16` | idp-golden-path ephemeral VPC | IPAM 払い出し（`terraform/ephemeral/`） | 検証時のみ存在 |

## 既知の重複について

ticket-c2c-platform (dev) と terraform-hannibal は、それぞれ独立に `10.0.0.0/16` を使用している。
両者は VPC ピアリング等で相互接続しておらず、実害はない。

VPC IPAM には既存 VPC の重複を承認・抑止する機能はなく（観測のみ）、既存 VPC の自動 import も有効化しない方針のため、
この重複は IPAM 側では対応せず、本台帳への記載をもって既知の事実として管理する。

新規プロジェクトが CIDR を確保する場合は、本台帳と IPAM プール範囲（`10.16.0.0/12`）を避けて選定し、本台帳に追記すること。
