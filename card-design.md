# PiCLuK カードデザイン設定

## 現在のデザイン（ネオン系）

### 手札カード（SlideCard）
```
プレイヤーカード色：#00ffff（シアン）
ディーラーカード色：#ff00ff（マゼンタ）
プレイヤー背景：linear-gradient(135deg,#050518,#0a0a2e)
ディーラー背景：linear-gradient(135deg,#18050a,#2a0015)
無効カード色：#333
無効カード背景：#0a0a1a
```

### 場のカード（FieldCard）
```
カード色：#ff00ff（マゼンタ）
背景：linear-gradient(135deg,#18050a,#2a0015)
```

### 変更箇所（4peace-final.html内）
SlideCard関数（約365行目）：
```javascript
const col = disabled ? '#333' : isBlue ? '#00ffff' : '#ff00ff';
const cardBg = disabled ? '#0a0a1a' : isBlue ? 'linear-gradient(135deg,#050518,#0a0a2e)' : 'linear-gradient(135deg,#18050a,#2a0015)';
```

FieldCard関数（約391行目）：
```javascript
const col = '#ff00ff';
const cardBg = 'linear-gradient(135deg,#18050a,#2a0015)';
```

---

## 背景・全体カラー

```
ゲーム背景：linear-gradient(180deg,#3a1a6e 0%,#6040a0 40%,#9060b8 70%,#c070c0 100%)
メインカラー(PANEL)：#7055b8
ボーダー(BORDER)：#c0a0ff
PINK：#00d4ff
PINK2：#80eeff
RED_C：#ff2d6e
BLUE_C：#ffaa00
```

---

## 音楽ファイル
- BGM：Grit_Sprint.mp3
- SE：se.mp3
