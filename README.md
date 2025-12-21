# Multi-Agent PR Review

5人のAI専門家がPRをレビューし、議論して多数決で判定するGitHub Actionです。

## 専門家

| 専門家 | 観点 |
|--------|------|
| セキュリティ専門家 | 脆弱性、認証、入力検証 |
| パフォーマンス専門家 | 計算量、メモリ、N+1問題 |
| 可読性専門家 | 命名、DRY、複雑度 |
| アーキテクチャ専門家 | SOLID、設計パターン、結合度 |
| テスト専門家 | カバレッジ、エッジケース |

## 使い方

### 1. Secretsを登録

リポジトリの **Settings → Secrets and variables → Actions** で以下を登録:

| Name | Value |
|------|-------|
| `ANTHROPIC_API_KEY` | Anthropic APIキー |

### 2. Workflowを作成

`.github/workflows/pr-review.yml` を作成:

```yaml
name: PR Review

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    if: github.event.pull_request.draft == false
    steps:
      - uses: udonrm/pr-review-multi-agent@main
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
```



## 出力例

### サマリー

```
## 🔴 マルチエージェントレビュー結果

| 判定 | 票数 |
|------|------|
| APPROVE | 2 |
| REQUEST_CHANGES | 3 |

**最終判定: REQUEST_CHANGES**
```

### インラインコメント（スレッド形式）

```
### セキュリティ専門家の指摘

**issue (blocking)**: SQLインジェクションの脆弱性

---

### 他の専門家の意見

**可読性専門家**: 👍 賛成
**パフォーマンス専門家**: 👍 賛成
**アーキテクチャ専門家**: 👎 反対

---

**結論**: 🔴 修正必要（賛成 4 / 反対 1）
```

## コスト

約 $0.10〜0.20 / PR（Claude Sonnet使用）

## ライセンス

MIT
