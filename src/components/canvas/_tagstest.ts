/*
 * D站标签选择器 —— 纯函数层断言（2026-10-08）。
 *
 * 与 `textChain` 那批单测同一个路子：**规则看不见，只能拿断言钉住**。
 * 这个文件不进产物，只在本地编译成 CJS 跑一遍（见 `_tsconfig.tagstest.json`）。
 */
import { isTextValueKind, resolveTextChain } from './textChain';
/* 只借类型：`import type` 编译期就抹掉了，不会把那个模块拉进这份测试的产物。 */
import type { CustomCategory } from '@/lib/danbooruCats';
import { entryFromInput, entryIdOf } from '@/lib/danbooruCats';
import {
  CUSTOM_KEY_PREFIX, characterTagsOf, characterThumb, composeTags, drawTags, normalizeTagSelection,
  emptyTagSelection, nextTagSeeds, rollTagText, tagKeysOf, tagModeOf, tagNeedsRedraw,
  type DanbooruData, type TagDraw, type TagSelection,
} from './danbooruTags';

let failed = 0;
function ok(name: string, cond: boolean, extra?: unknown) {
  if (cond) { console.log('  PASS ' + name); return; }
  failed += 1;
  console.log('  FAIL ' + name + (extra === undefined ? '' : ' -> ' + JSON.stringify(extra)));
}

const DATA: DanbooruData = {
  characters: [
    {
      name: 'hatsune miku', copyright: 'vocaloid', post_count: 1, gender: '1girl', hair: 'aqua', eye: 'aqua',
      /* 官方那一组（真清单里平均 11.8 条，这里裁短；4000 条里自指/内部重复都是 0 条）。 */
      tags: ['1girl', 'aqua eyes', 'blue eyes', 'very long hair', 'twintails'],
    },
    /* 没有官方标签组的角色（真清单里有 56 个），以及一个根本不在清单里的名字。 */
    { name: 'toujou nozomi', copyright: 'love live!', post_count: 1, gender: '', hair: '', eye: '', tags: [] },
  ],
  artists: [{ name: 'dairi', post_count: 1 }, { name: 'ebifurya', post_count: 2 }],
  poses: [{ id: 'p1', name: 'Armpits', name_zh: '举手露腋', tags: 'armpits, armpit', categories: [], preview: '' }],
  backgrounds: [{ id: 'b1', name: 'Beach', name_zh: '海滩', tags: 'beach, sand', categories: [], preview: '' }],
  clothings: [{ id: 'c1', name: 'Sailor Uniform', name_zh: '水手服', tags: 'sailor dress, serafuku', categories: [], preview: '' }],
  /* 镜头那一档（2026-10-09）：真清单是 Danbooru 官方 image composition 那三节，29 条。 */
  shots: [
    { id: 's1', name: 'Cowboy Shot', name_zh: '中景', tags: 'cowboy_shot', categories: ['景别 (Framing the body)'], preview: '' },
    { id: 's2', name: 'Close-Up', name_zh: '特写', tags: 'close-up', categories: ['景别 (Framing the body)'], preview: '' },
  ],
  /* 画面效果那一档（2026-10-10）：真清单是 Danbooru 官方 lighting + Techniques 两页，33 条。 */
  effects: [
    { id: 'e1', name: 'Light Rays', name_zh: '丁达尔效应', tags: 'light_rays', categories: ['光效 (Lighting)'], preview: '' },
    { id: 'e2', name: 'Bokeh', name_zh: '散景', tags: 'bokeh', categories: ['镜头与质感 (Optics & Texture)'], preview: '' },
  ],
  /* 表情那一档（2026-10-10）：真清单是 Danbooru 官方 tag_group:face_tags，79 条。 */
  expressions: [
    { id: 'x1', name: 'Smile', name_zh: '微笑（闭嘴）', tags: 'smile', categories: ['笑 (Smile)'], preview: '' },
    { id: 'x2', name: 'Blush', name_zh: '脸红', tags: 'blush', categories: ['情绪 (Emotions)'], preview: '' },
  ],
  /*
   * 头发 / 眼睛 / 画风 / 种族这四档（2026-10-10 徐先：「加上」）。
   * 真清单分别是 112 / 61 / 56 / 116 条，每条都逐个在标签库里查过存在。
   */
  hairs: [
    { id: 'h1', name: 'Blonde Hair', name_zh: '金发', tags: 'blonde_hair', categories: ['发色 (Hair color)'], preview: '' },
    { id: 'h2', name: 'Twintails', name_zh: '双马尾', tags: 'twintails', categories: ['长度与发型 (Length & hairstyle)'], preview: '' },
  ],
  eyes: [
    { id: 'y1', name: 'Blue Eyes', name_zh: '蓝眼', tags: 'blue_eyes', categories: ['眼色 (Iris color)'], preview: '' },
    { id: 'y2', name: 'Heterochromia', name_zh: '异色瞳', tags: 'heterochromia', categories: ['眼色 (Iris color)'], preview: '' },
  ],
  styles: [
    { id: 'f1', name: 'Cyberpunk', name_zh: '赛博朋克', tags: 'cyberpunk', categories: ['美学风格 (Aesthetics)'], preview: '' },
    { id: 'f2', name: 'Ukiyo-e', name_zh: '浮世绘', tags: 'ukiyo-e', categories: ['艺术流派 (Art movements)'], preview: '' },
  ],
  creatures: [
    { id: 'k1', name: 'Elf', name_zh: '精灵', tags: 'elf', categories: ['幻想种族 (Races)'], preview: '' },
    { id: 'k2', name: 'Cat Ears', name_zh: '猫耳', tags: 'cat_ears', categories: ['兽耳与尾巴 (Kemonomimi)'], preview: '' },
  ],
};

const sel = (part: Partial<TagSelection>): TagSelection => ({ ...emptyTagSelection(), ...part });

console.log('1) 文本链认不认这个节点');
ok('isTextValueKind(danbooru-tags)', isTextValueKind('danbooru-tags') === true);

const nodes = [
  { id: 'tag1', data: { kind: 'danbooru-tags', tagText: 'beach, sand, ' } },
  { id: 'txt1', data: { kind: 'text', text: '一只猫' } },
  { id: 'gen1', data: { kind: 'image-generate' } },
];
const chain = resolveTextChain(nodes, [{ source: 'tag1', target: 'gen1' }], 'gen1');
ok('下游生成节点拿到标签串', chain.value.indexOf('beach, sand') >= 0, chain.value);

const both = resolveTextChain(nodes, [
  { source: 'tag1', target: 'gen1' },
  { source: 'txt1', target: 'gen1' },
], 'gen1');
ok('标签 + 手写提示词都进去了', both.value.indexOf('beach, sand') >= 0 && both.value.indexOf('一只猫') >= 0, both.value);
/*
 * 注意每段都被 `joinTextParts` 削过首尾空白，所以标签串尾那个 ", " 到这里是 ","。
 * 这正是想要的：不然会拼出「beach, sand, , 一只猫」这种逗点夹心。
 */
ok('两段之间空一行', both.value.indexOf('beach, sand,\n\n一只猫') >= 0 || both.value.indexOf('一只猫\n\nbeach, sand,') >= 0, both.value);
ok('拼完不会留下逗点夹心', both.value.indexOf(', ,') < 0, both.value);

const emptyTag = resolveTextChain([{ id: 'tag2', data: { kind: 'danbooru-tags' } }], [], 'tag2');
ok('没抽过就是空串（不是 undefined）', emptyTag.value === '', emptyTag.value);

console.log('2) 抽签');
const pool = sel({ characters: ['a', 'b', 'c', 'd'], poses: ['p1'], backgrounds: ['b1'], clothings: ['c1'], artists: ['dairi'] });
const d1 = drawTags(pool, DATA, 12345);
const d2 = drawTags(pool, DATA, 12345);
const d3 = drawTags(pool, DATA, 999);
ok('同一个 seed 抽到同一批', d1.character === d2.character, [d1.character, d2.character]);
ok('画师是**全部**串上，不是抽一个', d1.artists.length === 1 && d1.artists[0] === 'dairi', d1.artists);
const seen = new Set<string>();
for (let i = 0; i < 200; i++) seen.add(drawTags(pool, DATA, i).character);
ok('换 seed 能抽到池里每一个（4/4）', seen.size === 4, Array.from(seen));
ok('不同 seed 会换人（或至少分布覆盖）', seen.size > 1);
ok('单个候选时怎么抽都是它', drawTags(sel({ characters: ['only'] }), DATA, d3 ? 7 : 7).character === 'only');

console.log('3) 组装');
const composed = composeTags(
  {
    character: 'hatsune miku', characterTags: [], pose: 'p1', background: 'b1', clothing: 'c1', shot: '', effect: '',
    expression: '', hair: '', eye: '', style: '', creature: '', artists: ['dairi', 'ebifurya'], custom: [],
  },
  DATA,
  'masterpiece',
);
ok('画师带 @ 前缀', composed.indexOf('@dairi, @ebifurya') === 0, composed);
ok('顺序 = 画师 → 角色 → 服装 → 环境 → 姿势 → 自定义',
  composed === '@dairi, @ebifurya, hatsune miku, sailor dress, serafuku, beach, sand, armpits, armpit, masterpiece, ', composed);
ok('结尾带 ", "（要接下游的字，不能粘住）', composed.endsWith(', '), composed.slice(-4));
const none: TagDraw = {
  character: '', characterTags: [], pose: '', background: '', clothing: '', shot: '', effect: '', expression: '',
  hair: '', eye: '', style: '', creature: '',
  artists: [], custom: [],
};
ok('啥都没选 = 空串', composeTags(none, DATA, '') === '');
ok('只有自定义时也要拼出来', composeTags(none, DATA, '1girl') === '1girl, ');
ok('自定义尾部的逗号会被削掉', composeTags(none, DATA, '1girl, ') === '1girl, ');
ok('抽到的服装 id 已经不在清单里时不炸、其余照拼',
  composeTags({ ...none, clothing: 'gone', character: 'x' }, DATA, '') === 'x, ');

console.log('4) 老数据容错');
ok('undefined -> 空选择', JSON.stringify(normalizeTagSelection(undefined)) === JSON.stringify(emptyTagSelection()));
const half = normalizeTagSelection({ characters: ['a'], mode: 'fixed' });
ok('缺字段补齐', half.poses.length === 0 && half.mode === 'fixed', half);
ok('乱七八糟的 mode 回落到 random', normalizeTagSelection({ mode: 'nonsense' as never }).mode === 'random');
ok('空串条目被剔掉', normalizeTagSelection({ artists: ['a', '', '  '] }).artists.length === 1);

console.log('5) 选完立刻就有串（不用等运行）');
const rolled = rollTagText(pool, DATA, 42);
ok('rollTagText 出得来东西', rolled.length > 0 && rolled.indexOf('@dairi') === 0, rolled);
ok('服装那一档也进了这一串', rolled.indexOf('sailor dress') > 0, rolled);

console.log('6) 角色预览图地址（拼出来的，不是存的）');
ok('有版权就拼得出',
  characterThumb('Hatsune Miku', 'Vocaloid')
  === 'https://blobs.animadex.net/Outputs/thumbs/hatsune%20miku%2C%20vocaloid.webp',
  characterThumb('Hatsune Miku', 'Vocaloid'));
ok('没有版权就返回空串（不拼一个必然 404 的地址）', characterThumb('nobody', '') === '');

console.log('7) 自定义分类（2026-10-08 晚：徐先要的「标签也可以自己加分类」）');
const cats: CustomCategory[] = [
  {
    id: 'q', name: '质量词', mode: 'all',
    entries: [
      { id: 'q1', label: 'masterpiece', tags: 'masterpiece' },
      { id: 'q2', label: 'best quality', tags: 'best quality' },
    ],
  },
  {
    id: 'w', name: '我的服装', mode: 'pick',
    entries: [
      { id: 'w1', label: '校服', tags: 'school uniform' },
      { id: 'w2', label: '和服', tags: 'kimono' },
    ],
  },
];
const customSel = sel({ custom: { q: ['q1', 'q2'], w: ['w1', 'w2'] } });
const drawn = drawTags(customSel, DATA, 7, cats);
ok('「整串接上」那一档：两条都进去，且按分类里的顺序',
  drawn.custom[0] === 'masterpiece' && drawn.custom[1] === 'best quality', drawn.custom);
ok('「抽 1 条」那一档：只出一条', drawn.custom.length === 3, drawn.custom);
const pickedW = new Set<string>();
for (let i = 0; i < 200; i++) pickedW.add(drawTags(customSel, DATA, i, cats).custom[2]);
ok('「抽 1 条」那一档 200 个种子能抽到池里两个', pickedW.size === 2, Array.from(pickedW));
ok('同一个种子抽两次结果完全一样',
  JSON.stringify(drawTags(customSel, DATA, 5, cats)) === JSON.stringify(drawTags(customSel, DATA, 5, cats)));
const withCat = rollTagText(sel({ poses: ['p1'], custom: { q: ['q1'] } }), DATA, 3, cats);
ok('自定义分类排在姿势之后、自由文本之前',
  withCat.indexOf('armpits, armpit, masterpiece') >= 0, withCat);
ok('分类被删了（清单里没有它）→ 跳过，不炸',
  drawTags(sel({ custom: { gone: ['x'] } }), DATA, 1, cats).custom.length === 0);
ok('条目被删了（分类里没这条 id）→ 跳过，不炸',
  drawTags(sel({ custom: { q: ['q9'] } }), DATA, 1, cats).custom.length === 0);
ok('老调用点不传分类清单时也不炸', drawTags(sel({ custom: { q: ['q1'] } }), DATA, 1).custom.length === 0);
ok('custom 那一份按形状归一（空串剔掉、非数组丢掉）',
  JSON.stringify(normalizeTagSelection({ custom: { q: ['a', '', ' '], bad: 'x' } }).custom) === JSON.stringify({ q: ['a'] }),
  normalizeTagSelection({ custom: { q: ['a', '', ' '], bad: 'x' } }).custom);
ok('手输一条 = 条目（标签即名字）', (() => {
  const entry = entryFromInput('  masterpiece  ');
  return entry?.tags === 'masterpiece' && entry.label === 'masterpiece';
})());
ok('同一条标签的 id 稳定（导两次不会出两条）', entryIdOf('kimono') === entryIdOf('kimono'));

console.log('8) 抽签模式**按档**走（2026-10-08 晚：徐先「每个都可以单独设置」）');
/* 老字段回落：老画布上只有节点级 `mode`，读回来每一档都得跟着它。 */
ok('没设过 modes 的档回落老的节点级 mode', tagModeOf(sel({ mode: 'fixed' }), 'character') === 'fixed');
ok('老字段是 random 时每档都 random', tagModeOf(sel({ mode: 'random' }), 'clothing') === 'random');
ok('设过的档听自己的（不被老字段拖走）',
  tagModeOf(sel({ mode: 'fixed', modes: { character: 'random' } }), 'character') === 'random');
ok('同一个节点里两档可以不一样',
  tagModeOf(sel({ mode: 'random', modes: { artist: 'fixed' } }), 'artist') === 'fixed'
  && tagModeOf(sel({ mode: 'random', modes: { artist: 'fixed' } }), 'pose') === 'random');
ok('自定义分类也有自己的键', tagModeOf(sel({ modes: { [`${CUSTOM_KEY_PREFIX}q`]: 'fixed' } }), `${CUSTOM_KEY_PREFIX}q`) === 'fixed');
ok('tagKeysOf 带上选择里出现过的自定义分类',
  tagKeysOf(sel({ custom: { q: ['q1'], w: ['w1'] } })).indexOf(`${CUSTOM_KEY_PREFIX}w`) > 0,
  tagKeysOf(sel({ custom: { q: ['q1'], w: ['w1'] } })).length);

/* 每档一条独立随机流：改别的档，这一档抽到的东西不许变。 */
const onlyChars = sel({ characters: ['a', 'b', 'c', 'd'] });
const charsPlus = sel({ characters: ['a', 'b', 'c', 'd'], poses: ['p1'], backgrounds: ['b1'], clothings: ['c1'] });
ok('加了别的档，这一档抽到的还是同一个（独立流）',
  drawTags(onlyChars, DATA, 42).character === drawTags(charsPlus, DATA, 42).character,
  [drawTags(onlyChars, DATA, 42).character, drawTags(charsPlus, DATA, 42).character]);
const customToo = sel({ characters: ['a', 'b', 'c', 'd'], custom: { q: ['q1', 'q2'] } });
ok('加了自定义档也一样不受影响',
  drawTags(onlyChars, DATA, 42).character === drawTags(customToo, DATA, 42, cats).character);

/* 「固定」跨轮不变、「每次运行抽」每轮换。 */
/* 角色固定、姿势随机 —— 两档的候选池都够大，才看得出「谁在动」。 */
const mixed = sel({ characters: ['a', 'b', 'c', 'd'], poses: ['p1', 'p2', 'p3', 'p4'], modes: { character: 'fixed', pose: 'random' } });
const s1 = nextTagSeeds(mixed, undefined, 'advance');
const s2 = nextTagSeeds(mixed, s1, 'advance');
ok('fixed 那档的种子跨轮沿用', s1.character === s2.character, [s1.character, s2.character]);
ok('random 那档的种子每轮换新的', s1.pose !== s2.pose, [s1.pose, s2.pose]);
ok('fixed 那档抽出来跨轮一样', drawTags(mixed, DATA, s1).character === drawTags(mixed, DATA, s2).character);
ok('每一档都有自己的种子（不是一个数字）', s1.character !== s1.pose);
ok('「换一批」把每一档都换掉', (() => {
  const forced = nextTagSeeds(mixed, s1, 'reroll');
  return forced.character !== s1.character && forced.pose !== s1.pose;
})(), nextTagSeeds(mixed, s1, 'reroll'));
/* 面板里改东西（`keep`）：种子一个都不许动 —— 否则点一下「固定」会把别的档重抽一遍。 */
ok('keep 时种子原样不动',
  JSON.stringify(nextTagSeeds(mixed, s1, 'keep')) === JSON.stringify(s1),
  nextTagSeeds(mixed, s1, 'keep'));
ok('keep 时随机那档也不换', nextTagSeeds(mixed, s1, 'keep').pose === s1.pose);
ok('第一次（没有旧种子）时 random/fixed 都给一把新的',
  typeof nextTagSeeds(mixed, undefined, 'keep').character === 'number'
  && nextTagSeeds(mixed, undefined, 'keep').character !== nextTagSeeds(mixed, undefined, 'keep').pose);
/* random 那档跨轮必须真的能换：连推 8 轮，抽到的姿势不止一个。 */
ok('random 那档连推多轮真的会换', (() => {
  let seeds = nextTagSeeds(mixed, undefined, 'advance');
  const seen2 = new Set<string>();
  for (let i = 0; i < 8; i += 1) {
    seen2.add(drawTags(mixed, DATA, seeds).pose);
    seeds = nextTagSeeds(mixed, seeds, 'advance');
  }
  return seen2.size > 1;
})());
/* 落到最终那串上：fixed 那段跨轮**逐字节**一样（这才是他要的那个「固定」）。 */
const head = (text: string): string => text.split(', ')[0];
ok('组装出来的串里 fixed 那段跨轮不变',
  head(rollTagText(mixed, DATA, s1)) === head(rollTagText(mixed, DATA, s2)),
  [rollTagText(mixed, DATA, s1), rollTagText(mixed, DATA, s2)]);
ok('同一个种子下整串完全一致（可复现）',
  rollTagText(mixed, DATA, s1) === rollTagText(mixed, DATA, s1));
/* 老画布兼容：整节点 fixed 又没有 modes → 一档随机的都没有 → 一个字都不写。 */
ok('整节点固定时不要去动节点', tagNeedsRedraw(sel({ characters: ['a'], mode: 'fixed' })) === false);
ok('有一档是「每次运行抽」才重抽', tagNeedsRedraw(sel({ characters: ['a'] })) === true);
ok('单独把角色设成固定 → 不重抽', tagNeedsRedraw(sel({ characters: ['a'], modes: { character: 'fixed' } })) === false);
ok('角色固定、但自定义那档没设过（默认随机）→ 仍要重抽',
  tagNeedsRedraw(sel({ characters: ['a'], modes: { character: 'fixed' }, custom: { q: ['q1'] } })) === true);
ok('没有候选就没什么可抽的', tagNeedsRedraw(sel({ modes: { character: 'random' } })) === false);
ok('画师只有「全串」一种，不算抽签', tagNeedsRedraw(sel({ artists: ['dairi'] })) === false);
/* modes 归一：脏值丢掉、形状对得上。 */
ok('modes 里的脏值会被丢掉',
  JSON.stringify(normalizeTagSelection({ modes: { character: 'fixed', bad: 'x', '': 'random' } }).modes)
  === JSON.stringify({ character: 'fixed' }),
  normalizeTagSelection({ modes: { character: 'fixed', bad: 'x', '': 'random' } }).modes);
ok('modes 不是对象时给空表', JSON.stringify(normalizeTagSelection({ modes: 'x' }).modes) === '{}');
ok('老数据读回来 modes 是空的、但 mode 还在',
  Object.keys(normalizeTagSelection({ characters: ['a'], mode: 'fixed' }).modes).length === 0
  && normalizeTagSelection({ characters: ['a'], mode: 'fixed' }).mode === 'fixed');

console.log('9) 角色的特征标签组（2026-10-08 晚：徐先「每个角色都有对应的一堆锁定标签」）');

/* 默认（老画布）—— 只出角色名，一个特征都不带。 */
const plainChar = sel({ characters: ['hatsune miku'] });
const plainDraw = drawTags(plainChar, DATA, 7);
ok('默认档只出角色名', plainDraw.character === 'hatsune miku' && plainDraw.characterTags.length === 0,
  plainDraw.characterTags);
ok('默认档拼出来的串只有角色名，没多一个字',
  composeTags(plainDraw, DATA, '') === 'hatsune miku, ', composeTags(plainDraw, DATA, ''));
/* 老画布读回来正好就是这个默认 —— 这一条要是挂了，他会发现所有节点突然多接十几个 tag。 */
ok('老画布读回来 characterDetail = false',
  normalizeTagSelection({ characters: ['hatsune miku'] }).characterDetail === false);
ok('老画布读回来换过的那组是空表',
  Object.keys(normalizeTagSelection({ characters: ['hatsune miku'] }).characterTagEdits).length === 0);

/* 切到「角色名 + 标签」。 */
const detailSel = sel({ characters: ['hatsune miku'], characterDetail: true });
const detailDraw = drawTags(detailSel, DATA, 7);
ok('detail 档把官方那组带出来', detailDraw.characterTags.length === 5, detailDraw.characterTags);
ok('带出来的就是官方清单里那份（顺序不动）',
  JSON.stringify(detailDraw.characterTags) === JSON.stringify(['1girl', 'aqua eyes', 'blue eyes', 'very long hair', 'twintails']),
  detailDraw.characterTags);const detailText = composeTags(detailDraw, DATA, '');
ok('角色名在前、特征标签紧随其后',
  detailText === 'hatsune miku, 1girl, aqua eyes, blue eyes, very long hair, twintails, ', detailText);

/* 改一条 / 删一条。 */
const edited = { ...detailSel, characterTagEdits: { 'hatsune miku': ['1girl', 'red eyes'] } };
ok('改过之后听改的那份',
  JSON.stringify(characterTagsOf(edited, DATA.characters[0])) === JSON.stringify(['1girl', 'red eyes']),
  characterTagsOf(edited, DATA.characters[0]));
ok('改过之后官方那份没被动过（出厂数据是只读基准）',
  JSON.stringify(DATA.characters[0].tags) === JSON.stringify(['1girl', 'aqua eyes', 'blue eyes', 'very long hair', 'twintails']),
  DATA.characters[0].tags);
ok('改过之后组装用的是改的那份',
  composeTags(drawTags(edited, DATA, 7), DATA, '') === 'hatsune miku, 1girl, red eyes, ',
  composeTags(drawTags(edited, DATA, 7), DATA, ''));
/*
 * 去重：官方清单里 4000 条自指 / 内部重复都是 **0 条**，所以这一层不是为出厂数据写的 ——
 * 它挡的是**用户手改**：把某一条改成角色名本身，不拦就会发出 `hatsune miku, hatsune miku`。
 */
const selfNamed = { ...detailSel, characterTagEdits: { 'hatsune miku': ['1girl', 'Hatsune Miku', 'aqua eyes'] } };
ok('手改成和角色名重名的那条会被去掉（大小写不敏感）',
  composeTags(drawTags(selfNamed, DATA, 7), DATA, '') === 'hatsune miku, 1girl, aqua eyes, ',
  composeTags(drawTags(selfNamed, DATA, 7), DATA, ''));
/* 🔴 删光的判据是「表里有这个键」，不是 `length` —— 用 length 判会当场把官方那组放回来。 */
const wiped = { ...detailSel, characterTagEdits: { 'hatsune miku': [] as string[] } };
ok('整组删光后一条都不出（不是回落到官方那份）',
  composeTags(drawTags(wiped, DATA, 7), DATA, '') === 'hatsune miku, ',
  composeTags(drawTags(wiped, DATA, 7), DATA, ''));
ok('进不了清单的角色名不炸、只出名字',
  composeTags(drawTags(sel({ characters: ['ghost'], characterDetail: true }), DATA, 7), DATA, '') === 'ghost, ');
ok('清单里没有官方标签组的角色，只出名字',
  composeTags(drawTags(sel({ characters: ['toujou nozomi'], characterDetail: true }), DATA, 7), DATA, '') === 'toujou nozomi, ');
/* 归一：空数组要留着，脏值丢掉。 */
const normEdit = normalizeTagSelection({
  characters: ['hatsune miku'],
  characterTagEdits: { 'hatsune miku': [], 'kirisame marisa': ['x', '  '], bad: 'nope', '': ['y'] },
}).characterTagEdits;
ok('归一后空数组留着（那是「一条都不要」）', normEdit['hatsune miku'].length === 0);
ok('归一后空串条目被剔掉、但不是整条丢键',
  JSON.stringify(normEdit['kirisame marisa']) === JSON.stringify(['x']), normEdit['kirisame marisa']);
ok('归一后不是数组的键丢掉', normEdit.bad === undefined && normEdit[''] === undefined);

console.log('10) 镜头那一档（2026-10-09 徐先：中景 / 近景 / 特写）');
/* 抽签：跟别的「抽一个」的档一个规矩。 */
const shotSel = sel({ shots: ['s1', 's2'] });
ok('镜头这一档能抽到', drawTags(shotSel, DATA, 7).shot.length > 0, drawTags(shotSel, DATA, 7).shot);
ok('同一个 seed 抽到同一个镜头', drawTags(shotSel, DATA, 7).shot === drawTags(shotSel, DATA, 7).shot);
const shotSeen = new Set<string>();
for (let i = 0; i < 200; i++) shotSeen.add(drawTags(shotSel, DATA, i).shot);
ok('换 seed 能抽到池里两个镜头', shotSeen.size === 2, Array.from(shotSeen));
/* 组装位置：姿势之后、自定义之前。 */
ok('镜头接在姿势之后',
  composeTags({ ...none, pose: 'p1', shot: 's1' }, DATA, '') === 'armpits, armpit, cowboy_shot, ',
  composeTags({ ...none, pose: 'p1', shot: 's1' }, DATA, ''));
const withShot = rollTagText(sel({ poses: ['p1'], shots: ['s1'], custom: { q: ['q1'] } }), DATA, 3, cats);
ok('镜头排在自定义分类之前', withShot.indexOf('cowboy_shot, masterpiece') >= 0, withShot);
ok('镜头排在整个串里姿势之后', withShot === 'armpits, armpit, cowboy_shot, masterpiece, ', withShot);
/*
 * 🔴 老画布兼容是这一档最要紧的一条：老节点上没有 `shots` 这个字段，
 *    读回来必须是空数组 —— 否则他一开画布，所有节点会当场多接一个镜头标签。
 */
ok('老画布读回来 shots 是空数组',
  JSON.stringify(normalizeTagSelection({ characters: ['a'], mode: 'fixed' }).shots) === '[]',
  normalizeTagSelection({ characters: ['a'], mode: 'fixed' }).shots);
ok('老画布那串一个字都不变（加这一档前后逐字节相同）',
  rollTagText(sel({ characters: ['a'], poses: ['p1'], backgrounds: ['b1'], clothings: ['c1'] }), DATA, 5)
    === 'a, sailor dress, serafuku, beach, sand, armpits, armpit, ',
  rollTagText(sel({ characters: ['a'], poses: ['p1'], backgrounds: ['b1'], clothings: ['c1'] }), DATA, 5));
/* 独立随机流：多挑一档镜头，别的档抽到的不许变（这条挂了「固定」就废了）。 */
ok('加了镜头那一档，角色抽到的还是同一个',
  drawTags(sel({ characters: ['a', 'b', 'c', 'd'] }), DATA, 42).character
    === drawTags(sel({ characters: ['a', 'b', 'c', 'd'], shots: ['s1', 's2'] }), DATA, 42).character);
/* 重不重抽：镜头这一档也算一档。 */
ok('镜头设成「每次运行抽」→ 要重抽', tagNeedsRedraw(sel({ shots: ['s1', 's2'] })) === true);
ok('镜头设成「固定这一批」→ 不重抽',
  tagNeedsRedraw(sel({ shots: ['s1', 's2'], modes: { shot: 'fixed' } })) === false);
ok('镜头这一档有自己的种子（不是跟姿势共用）', (() => {
  const seeds = nextTagSeeds(sel({ poses: ['p1'], shots: ['s1', 's2'] }), undefined, 'advance');
  return typeof seeds.shot === 'number' && seeds.shot !== seeds.pose;
})());
/* 抽到一条已经不在清单里的 id → 跳过，不炸（清单是随包走的，id 对不上是可能的）。 */
ok('抽到的镜头 id 不在清单里时不炸、其余照拼',
  composeTags({ ...none, shot: 'gone', character: 'x' }, DATA, '') === 'x, ',
  composeTags({ ...none, shot: 'gone', character: 'x' }, DATA, ''));

console.log('11) 画面效果（2026-10-10 徐先要的「丁达尔效应」那类）');
const effSel = sel({ effects: ['e1', 'e2'] });
ok('画面效果这一档能抽到', drawTags(effSel, DATA, 7).effect.length > 0, drawTags(effSel, DATA, 7).effect);
ok('同一个 seed 抽到同一个效果', drawTags(effSel, DATA, 7).effect === drawTags(effSel, DATA, 7).effect);
const effSeen = new Set<string>();
for (let i = 0; i < 200; i++) effSeen.add(drawTags(effSel, DATA, i).effect);
ok('换 seed 能抽到池里两个效果', effSeen.size === 2, Array.from(effSeen));
/* 顺序：姿势 → 镜头 → **效果** → 自定义 → 自由文本。 */
ok('效果接在镜头之后、自定义之前',
  composeTags({ ...none, pose: 'p1', shot: 's1', effect: 'e1' }, DATA, '') === 'armpits, armpit, cowboy_shot, light_rays, ',
  composeTags({ ...none, pose: 'p1', shot: 's1', effect: 'e1' }, DATA, ''));
const withEff = rollTagText(sel({ poses: ['p1'], shots: ['s1'], effects: ['e1'], custom: { q: ['q1'] } }), DATA, 3, cats);
ok('效果排在自定义分类之前',
  withEff === 'armpits, armpit, cowboy_shot, light_rays, masterpiece, ', withEff);
/*
 * 🔴 老画布兼容（这一档最要紧的一条）：老节点上没有 `effects` 这个字段，
 *    读回来必须是空数组 —— 于是拼出来的串跟加这一档之前**逐字节相同**。
 */
ok('老画布读回来 effects 是空数组',
  JSON.stringify(normalizeTagSelection({ characters: ['a'], mode: 'fixed' }).effects) === '[]',
  normalizeTagSelection({ characters: ['a'], mode: 'fixed' }).effects);
ok('老画布那串一个字都不变（镜头 + 效果两档都在了，串仍逐字节相同）',
  rollTagText(sel({ characters: ['a'], poses: ['p1'], backgrounds: ['b1'], clothings: ['c1'] }), DATA, 5)
    === 'a, sailor dress, serafuku, beach, sand, armpits, armpit, ',
  rollTagText(sel({ characters: ['a'], poses: ['p1'], backgrounds: ['b1'], clothings: ['c1'] }), DATA, 5));
/* 独立随机流：多挑一档效果，别的档抽到的不许变（这条挂了「固定」就废了）。 */
ok('加了效果那一档，角色抽到的还是同一个',
  drawTags(sel({ characters: ['a', 'b', 'c', 'd'] }), DATA, 42).character
    === drawTags(sel({ characters: ['a', 'b', 'c', 'd'], effects: ['e1', 'e2'] }), DATA, 42).character);
ok('效果与镜头两条流互不干扰（各自一把种子）', (() => {
  const seeds = nextTagSeeds(sel({ shots: ['s1', 's2'], effects: ['e1', 'e2'] }), undefined, 'advance');
  return typeof seeds.effect === 'number' && seeds.effect !== seeds.shot;
})());
ok('效果设成「每次运行抽」→ 要重抽', tagNeedsRedraw(sel({ effects: ['e1', 'e2'] })) === true);
ok('效果设成「固定这一批」→ 不重抽',
  tagNeedsRedraw(sel({ effects: ['e1', 'e2'], modes: { effect: 'fixed' } })) === false);
ok('抽到的效果 id 不在清单里时不炸、其余照拼',
  composeTags({ ...none, effect: 'gone', character: 'x' }, DATA, '') === 'x, ',
  composeTags({ ...none, effect: 'gone', character: 'x' }, DATA, ''));

console.log('12) 表情（2026-10-10 徐先：「d站标签添加表情分类」）');
const exprSel = sel({ expressions: ['x1', 'x2'] });
ok('表情这一档能抽到', drawTags(exprSel, DATA, 7).expression.length > 0, drawTags(exprSel, DATA, 7).expression);
ok('同一个 seed 抽到同一个表情', drawTags(exprSel, DATA, 7).expression === drawTags(exprSel, DATA, 7).expression);
const exprSeen = new Set<string>();
for (let i = 0; i < 200; i++) exprSeen.add(drawTags(exprSel, DATA, i).expression);
ok('换 seed 能抽到池里两个表情', exprSeen.size === 2, Array.from(exprSeen));
/*
 * 顺序：姿势 → 镜头 → 效果 → **表情** → 自定义 → 自由文本。
 * 🔴 表情接在内置那几档的**最后面**，跟镜头 / 效果同一个理由：只有这一档真选了东西
 *    才多出一段，老画布上这一档是空的 → 串逐字节不变。
 */
ok('表情接在效果之后、自定义之前',
  composeTags({ ...none, pose: 'p1', shot: 's1', effect: 'e1', expression: 'x1' }, DATA, '')
    === 'armpits, armpit, cowboy_shot, light_rays, smile, ',
  composeTags({ ...none, pose: 'p1', shot: 's1', effect: 'e1', expression: 'x1' }, DATA, ''));
const withExpr = rollTagText(
  sel({ poses: ['p1'], shots: ['s1'], effects: ['e1'], expressions: ['x1'], custom: { q: ['q1'] } }), DATA, 3, cats,
);
ok('表情排在自定义分类之前、效果之后',
  withExpr === 'armpits, armpit, cowboy_shot, light_rays, smile, masterpiece, ', withExpr);
/* 🔴 老画布兼容（这一档最要紧的一条）：老节点没有 `expressions` 字段 → 空数组。 */
ok('老画布读回来 expressions 是空数组',
  JSON.stringify(normalizeTagSelection({ characters: ['a'], mode: 'fixed' }).expressions) === '[]',
  normalizeTagSelection({ characters: ['a'], mode: 'fixed' }).expressions);
ok('老画布那串一个字都不变（镜头 + 效果 + 表情三档都在了，串仍逐字节相同）',
  rollTagText(sel({ characters: ['a'], poses: ['p1'], backgrounds: ['b1'], clothings: ['c1'] }), DATA, 5)
    === 'a, sailor dress, serafuku, beach, sand, armpits, armpit, ',
  rollTagText(sel({ characters: ['a'], poses: ['p1'], backgrounds: ['b1'], clothings: ['c1'] }), DATA, 5));
/* 独立随机流：多挑一档表情，别的档抽到的不许变（这条挂了「固定」就废了）。 */
ok('加了表情那一档，角色抽到的还是同一个',
  drawTags(sel({ characters: ['a', 'b', 'c', 'd'] }), DATA, 42).character
    === drawTags(sel({ characters: ['a', 'b', 'c', 'd'], expressions: ['x1', 'x2'] }), DATA, 42).character);
ok('表情与效果两条流互不干扰（各自一把种子）', (() => {
  const seeds = nextTagSeeds(sel({ effects: ['e1', 'e2'], expressions: ['x1', 'x2'] }), undefined, 'advance');
  return typeof seeds.expression === 'number' && seeds.expression !== seeds.effect;
})());
ok('表情设成「每次运行抽」→ 要重抽', tagNeedsRedraw(sel({ expressions: ['x1', 'x2'] })) === true);
ok('表情设成「固定这一批」→ 不重抽',
  tagNeedsRedraw(sel({ expressions: ['x1', 'x2'], modes: { expression: 'fixed' } })) === false);
ok('抽到的表情 id 不在清单里时不炸、其余照拼',
  composeTags({ ...none, expression: 'gone', character: 'x' }, DATA, '') === 'x, ',
  composeTags({ ...none, expression: 'gone', character: 'x' }, DATA, ''));

console.log('5g) 头发 / 眼睛 / 画风 / 种族这四档（2026-10-10 徐先：「加上」）');
ok('四档接在表情之后、自定义之前，次序是 头发→眼睛→画风→种族',
  composeTags({ ...none, expression: 'x1', hair: 'h1', eye: 'y1', style: 'f1', creature: 'k1' }, DATA, '')
    === 'smile, blonde_hair, blue_eyes, cyberpunk, elf, ',
  composeTags({ ...none, expression: 'x1', hair: 'h1', eye: 'y1', style: 'f1', creature: 'k1' }, DATA, ''));
const withFour = rollTagText(
  sel({ hairs: ['h1', 'h2'], eyes: ['y1'], styles: ['f2'], creatures: ['k2'], custom: { q: ['q1'] } }), DATA, 7, cats,
);
ok('四档排在自定义分类之前',
  withFour === 'blonde_hair, blue_eyes, ukiyo-e, cat_ears, masterpiece, ', withFour);
/* 🔴 老画布兼容（这四档最要紧的那条）：老节点没有这四个字段 → 空数组。 */
const oldSel = normalizeTagSelection({ characters: ['a'], mode: 'fixed' });
ok('老画布读回来 hairs / eyes / styles / creatures 都是空数组',
  JSON.stringify([oldSel.hairs, oldSel.eyes, oldSel.styles, oldSel.creatures]) === '[[],[],[],[]]',
  [oldSel.hairs, oldSel.eyes, oldSel.styles, oldSel.creatures]);
ok('老画布那串一个字都不变（镜头 + 效果 + 表情 + 这四档都在了，串仍逐字节相同）',
  rollTagText(sel({ characters: ['a'], poses: ['p1'], backgrounds: ['b1'], clothings: ['c1'] }), DATA, 5)
    === 'a, sailor dress, serafuku, beach, sand, armpits, armpit, ',
  rollTagText(sel({ characters: ['a'], poses: ['p1'], backgrounds: ['b1'], clothings: ['c1'] }), DATA, 5));
/* 独立随机流：多挑一档，别的档抽到的不许变（这条挂了「固定」就废了）。 */
ok('加了头发那一档，角色抽到的还是同一个',
  drawTags(sel({ characters: ['a', 'b', 'c', 'd'] }), DATA, 42).character
    === drawTags(sel({ characters: ['a', 'b', 'c', 'd'], hairs: ['h1', 'h2'] }), DATA, 42).character);
ok('这四档各有一把种子（互不干扰）', (() => {
  const seeds = nextTagSeeds(sel({ hairs: ['h1'], eyes: ['y1'], styles: ['f1'], creatures: ['k1'] }), undefined, 'advance');
  const keys = ['hair', 'eyes', 'style', 'creature'];
  const nums = keys.map(k => seeds[k]);
  return nums.every(n => typeof n === 'number') && new Set(nums).size === keys.length;
})());
ok('头发设成「每次运行抽」→ 要重抽', tagNeedsRedraw(sel({ hairs: ['h1', 'h2'] })) === true);
ok('画风设成「固定这一批」→ 不重抽',
  tagNeedsRedraw(sel({ styles: ['f1', 'f2'], modes: { style: 'fixed' } })) === false);
ok('抽到的种族 id 不在清单里时不炸、其余照拼',
  composeTags({ ...none, creature: 'gone', character: 'x' }, DATA, '') === 'x, ',
  composeTags({ ...none, creature: 'gone', character: 'x' }, DATA, ''));

console.log(failed === 0 ? '\nALL PASS' : '\nFAILED ' + failed);
process.exit(failed === 0 ? 0 : 1);