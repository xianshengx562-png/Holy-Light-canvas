# 中文意图 → 英文 prompt 翻译指引

Midjourney 对中文支持差,**丢进 MJ 的 prompt 必须是英文**(另出一版中文平行版供阅读/修改)。用中文和用户沟通、走 intake、给释义都可以,但出图字符串一律翻成英文。**翻"意象"不翻"字面"** —— 把中文美学概念译成 MJ 真正吃得动的英文描述,而不是逐字直译。

## 工作方式
1. 中文对话,确认主体/风格/画幅(走 `construction-method.md` 的 6 槽)。
2. 把每个中文美学意图查下表或自行意译成**具体英文描述短语**。
3. 输出**中文版 + 英文版两版** prompt 代码块(英文版是丢进 MJ 的那版,中文版供阅读/修改),再附一句中文释义(说明你怎么理解他的意图)。
4. 绝不让中文混进**英文版** prompt 正文(英文版是给 MJ 的);中文版本身是中文,不受此限。

## 意象对照(译意不译字)
| 中文意图 | 英文 prompt 译法(意象) | 别用(字面直译) |
|---|---|---|
| 国风 / 中国风 | traditional Chinese aesthetic, ink-wash brushwork, flowing silk | "Chinese style" |
| 水墨 | sumi-e ink wash, sparse gestural strokes, rice-paper texture | "water ink painting" |
| 古风 | ancient Chinese setting, Hanfu robes, classical architecture | "ancient style" |
| 仙侠 / 修仙 | ethereal xianxia fantasy, floating mountains, flowing robes, jade and mist | "immortal hero" |
| 赛博朋克 | cyberpunk, neon-soaked rain-slick streets, tech-noir | (字面通常 OK,但补环境) |
| 电影感 | cinematic, anamorphic lens, teal-and-orange grade, shallow DoF | "movie feeling" |
| 高级感 | refined, restrained palette, editorial minimalism, premium materials | "high-class feeling" |
| 治愈 / 小清新 | soft pastel, gentle natural light, airy and calm | "healing" |
| 国潮 | modern Chinese street-culture graphic design, bold retro-pop | "national tide" |
| 烟火气 | warm everyday street life, lived-in detail, golden lamplight | "fireworks air" |
| 高级灰 | muted desaturated grey palette, low contrast | "advanced grey" |
| 氛围感 | moody atmospheric lighting, soft haze, intimate tone | "atmosphere feeling" |
| 大片感 | epic blockbuster shot, dramatic scale and lighting | "big film feeling" |
| 二次元 | anime / manga aesthetic (→ consider `--niji 7`) | "two-dimensional" |
| 水墨 + 留白 | ink wash with generous negative space, minimal composition | — |

## 易错陷阱
- **逐字直译会废**:成语、网络词、品牌化形容词("高级""治愈""氛围")直译后 MJ 不认,必须落到**可视觉化的具体描述**(光线/材质/色彩/构图)。
- **抽象情绪要落地**:中文常给情绪("孤独的""温暖的"),英文 prompt 要给**画面成因**(`a single figure on an empty pier, cold blue dusk` 而不是 `lonely`)。
- **画幅别忘**:中文用户常说"竖屏/手机壁纸/公众号封面",对应 `--ar 9:16` / `--ar 3:4` 等,在 intake 就问清。
- **文字渲染**:中文文字 MJ 几乎渲染不准;若要画面带字,改用**英文短词 + 双引号**,并提示用户中文字建议后期用设计软件加。
