# `.layers` ファイル形式

`.layers` は HoloCard の中間形式です。レイヤー分割パイプラインがこれを出力し、Web サイトのレンダラーと [`@holocard/player`](/ja/player/) がこれを読み込みます。この形式によってレイヤー分割アルゴリズムとカードの描画が切り離されているため、この形式を出力できるもの（画像編集ソフトで手作業で切り分けたレイヤーを含む）であれば何でもレンダラーに渡せます。[API](/ja/api/) が返す結果も同じ形式です。

形式の定義は `src/format/types.ts`、読み込みと検証は `src/format/io.ts`、編集可能なフィールドの検証は `src/format/config.ts` にあります。

## ディレクトリ構成

1 枚のカードは 1 つのディレクトリで、`manifest.json` 1 つとレイヤーごとの画像 1 枚ずつを含みます。

```
mycard.layers/
├── manifest.json
├── layer-0.webp      # 一番奥
├── layer-1.webp
└── layer-2.webp      # 一番手前
```

- 各レイヤー画像は元画像と同じサイズで透明チャンネルを持ち、`manifest.json` の順に奥から重ねると元画像が再現されます。
- 画像の透明チャンネルは、そのレイヤーの形であると同時に、そのレイヤーのホイルのマスクでもあります。
- 画像はブラウザがデコードできる形式であれば何でも構いません。サーバーが出力するのは WebP（色は非可逆、透明チャンネルは可逆）です。
- ファイル名は自由ですが、`manifest.json` と同じディレクトリにあるファイル名に限られ、パス区切り文字や `..` を含めることはできません。

## manifest.json

### トップレベルのフィールド

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `version` | number | はい | 形式のバージョン。現在は `1` でなければならず、それ以外は読み込みを拒否します |
| `source` | object | はい | 元画像のサイズ。下表を参照 |
| `layers` | array | はい | レイヤー。1 つ以上。下表を参照 |
| `effects` | object | いいえ | カード全体の効果。省略時は既定値。下表を参照 |
| `generator` | string | いいえ | 調査用の生成元の識別子。例：`holocard-web/0.1.0 depth-anything-v2-small layers=2` |

### `source`

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `source.width` | number | はい | 元画像の幅（ピクセル） |
| `source.height` | number | はい | 元画像の高さ（ピクセル） |

レンダラーは `width / height` をカードの縦横比として使います。

### `layers[]`

| フィールド | 型 | 必須 | 既定値 | 説明 |
|---|---|---|---|---|
| `file` | string | はい | — | レイヤー画像のファイル名。`manifest.json` のあるディレクトリからの相対 |
| `depth` | number | はい | — | レイヤーの代表的な奥行き。`0` が一番奥、`1` が一番手前 |
| `parallax` | number | いいえ | `depth` と同じ | 視差係数。「プレーヤーと Web サイトでの使われ方」を参照 |
| `bbox` | `[x, y, w, h]` | はい | — | レイヤーの有効なピクセルのバウンディングボックス。ピクセル座標の 4 つの数値 |
| `inpainted` | boolean | いいえ | `false` | 隠れていた領域が補完済みかどうか。`true` のときのみ補完済みとみなします |
| `foil` | object | いいえ | レイヤー順に決定（下記） | そのレイヤーのホイル |
| `foil.type` | string | はい（`foil` がある場合） | — | ホイルの種類。「ホイルの種類」を参照 |
| `foil.intensity` | number | いいえ | `1` | ホイルの強さ。0〜1。範囲外の値は切り詰めます |

読み込み時に `layers` は `depth` の昇順に並べ替えられるため、ファイル内の記述順にかかわらず `layers[0]` は常に一番奥のレイヤーです。

`foil` がない場合や `foil.type` が不正な場合は、レイヤー順に応じて既定のホイルを割り当てます。

| レイヤー数 | 一番奥 | 中間 | 一番手前 |
|---|---|---|---|
| 1 | `sunpillar`、強さ 1 | — | — |
| 2 以上 | `sunpillar`、強さ 1 | `holo`、強さ 0.8 | `none`、強さ 1 |

### `effects`

| フィールド | 型 | 既定値 | 範囲 | 説明 |
|---|---|---|---|---|
| `effects.halo.intensity` | number | `0.35` | 0〜1 | カード全体のハローの強さ。`0` でオフ |
| `effects.halo.light.peakAt` | `[nx, ny]` | `[0.7, -0.7]` | それぞれ -1〜1 | ハローが最も強くなるポインター位置。`[0, 0]` がカード中央。既定の光源は右上 |
| `effects.halo.light.sharpness` | number | `120` | 10〜400 | 角度の窓の鋭さ。大きいほどハローが現れる傾きの範囲が狭くなります |
| `effects.glare` | boolean | `true` | — | ポインターに追従するグレアを表示するか。`false` のときのみオフ |
| `effects.parallax` | object | なし | — | 作者が保存した視差の設定。省略可 |
| `effects.parallax.enabled` | boolean | — | — | 視差のオン・オフ |
| `effects.parallax.amplitude` | number | — | 0〜0.16 | 視差の振幅（カード幅に対する割合）。スイッチがオフでも値は保持されます |

`effects.parallax` は、完全かつ正しい場合（`enabled` が真偽値で、`amplitude` が 0〜0.16）にのみ採用され、それ以外は保存されていないものとして扱います。

## ホイルの種類

`foil.type` の値（`FOIL_TYPES`）：

| 値 | Web サイトでの名前 | 効果 | 元のレシピ（pokemon-cards-css） |
|---|---|---|---|
| `none` | マット（ホイルなし） | ホイルなし。実物のカードで不透明インクに覆われた主役に相当 | — |
| `holo` | クラシックホロ | 斜めの虹、細い走査線、縦の格子 | rare holo |
| `sunpillar` | サンピラー | 斜めのサンピラー状の虹と金属粒子 | rare holo v |
| `rainbow` | レインボーラメ | ラメと多色グラデーション | rare rainbow |

## 例

Web サイトのトップページにあるサンプルカード（`public/samples/demo/manifest.json`）です。2 レイヤーで、視差の設定は保存されていません。

```json
{
  "version": 1,
  "source": { "width": 1400, "height": 788 },
  "generator": "holocard-web/0.1.0 depth-anything-v2-small layers=2 cuts=[0.251@0.137]",
  "layers": [
    {
      "file": "layer-0.webp",
      "depth": 0.13380292057991028,
      "parallax": 0,
      "bbox": [0, 0, 1400, 788],
      "inpainted": true,
      "foil": { "type": "sunpillar", "intensity": 1 }
    },
    {
      "file": "layer-1.webp",
      "depth": 0.5165139436721802,
      "parallax": 1,
      "bbox": [436, 59, 832, 729],
      "inpainted": false,
      "foil": { "type": "none", "intensity": 1 }
    }
  ],
  "effects": {
    "halo": { "intensity": 0.35, "light": { "peakAt": [0.7, -0.7], "sharpness": 120 } },
    "glare": true
  }
}
```

持ち主が Web サイトで調整して保存すると、`effects` に `parallax` が追加されます。例：

```json
"parallax": { "enabled": true, "amplitude": 0.1 }
```

## プレーヤーと Web サイトでの使われ方

Web サイトのレンダラーと `@holocard/player` は同じ描画コード（`src/renderer/`）を使い、各フィールドの扱いも同じです。違いは `effects.parallax` がない場合の視差の振幅だけです。

| フィールド | 用途 |
|---|---|
| `source.width` / `source.height` | カードの縦横比 |
| `layers[].depth` | レイヤーの前後順。`parallax` がない場合は視差係数として使用 |
| `layers[].parallax` | 各レイヤーの移動量 = (`parallax` − 焦点面) × 振幅。焦点面は全レイヤーの `parallax` の最小値と最大値の中点で、手前のレイヤーは外側へ、奥のレイヤーは内側へ動きます。端に余白が出ないよう、全レイヤーを同じ倍率 1 + 2 × 最大オフセット × 振幅 で拡大します。`parallax` が等しい隣接レイヤーは 1 つのグループとして一緒に動き、ハローとグレアを共有します |
| `layers[].file` | レイヤー画像。その透明チャンネルがそのレイヤーのホイルのマスクにもなります |
| `layers[].foil` | そのレイヤーのホイルの種類と強さ。ホイルはレイヤーの形の内側にのみ表示されます |
| `layers[].bbox` | 有効なピクセルの範囲を示します。現在のレンダラーは使用しません |
| `layers[].inpainted` | 隠れた領域が補完済みかを示します。現在のレンダラーは使用しません。補完されていないレイヤーは大きく動かすと穴が見えます |
| `effects.halo` | カード全体のハローの強さと角度の窓。Web サイトで調整中は、効果が見えるようにカードが `peakAt` の角度まで傾きます |
| `effects.glare` | `false` のときグレアを表示しません |
| `effects.parallax` | ある場合：Web サイトもプレーヤーもこれに従います（`enabled` が `false` なら振幅 0）。ない場合：Web サイトは閲覧者の端末の「立体視差」設定と振幅 2% を使い、プレーヤーは既定の振幅 0.02 を使います |
| `generator` | Web サイトでは処理完了時にステータス欄に表示します。描画には使いません |

### 作者の設定

Web サイトで編集でき、カードとともに保存されるのは次のフィールドだけで、これを作者の設定（`CardConfig`）と呼びます。持ち主がパネルで調整すると、Web サイトはこれをサーバーに保存し、サーバーは検証したうえで `manifest.json` にマージします。共有ページ、共有プレビュー画像、書き出したアニメーションはすべて保存後の内容で描画されます。

| 作者の設定 | 対応する manifest のフィールド | 範囲 |
|---|---|---|
| `foils[]`（`layers` と 1 対 1、奥から手前） | `layers[].foil.type`、`layers[].foil.intensity` | `FOIL_TYPES` のいずれか；0〜1 |
| `halo.intensity` | `effects.halo.intensity` | 0〜1 |
| `halo.sharpness` | `effects.halo.light.sharpness` | 10〜400 |
| `parallax.enabled`、`parallax.amplitude` | `effects.parallax` | 真偽値；0〜0.16 |

ホイルの数はカードのレイヤー数と一致している必要があり、1 つでも不正な値があると設定全体が拒否されます。レイヤーのファイル名、奥行き、視差係数、`peakAt` などはパイプラインが決めるもので、Web サイトから変更することはできません。

`manifest.json` の読み込み時、`effects.halo.intensity` と `sharpness` は有限の数値であることだけが求められ、範囲は検査されません。Web サイトはそのような manifest から作者の設定を取り出す際、上表の範囲に切り詰めます。
