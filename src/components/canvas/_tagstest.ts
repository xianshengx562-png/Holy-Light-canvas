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
  characterThumb, composeTags, drawTags, normalizeTagSelection, emptyTagSelection, rollTagText,
  type DanbooruData, type TagDraw, type TagSelection,
} from './danbooruTags';

let failed = 0;
function ok(name: string, cond: boolean, extra?: unknown) {
  if (cond) { console.log('  PASS ' + name); return; }
  failed += 1;
  console.log('  FAIL ' + name + (extra === undefined ? '' : ' -> ' + JSON.stringify(extra)));
}

const DATA: DanbooruData = {
  characters: [{ name: 'hatsune miku', copyright: 'vocaloid', post_count: 1, gender: '', hair: '', eye: '' }],
  artists: [{ name: 'dairi', post_count: 1 }, { name: 'ebifurya', post_count: 2 }],
  poses: [{ id: 'p1', name: 'Armpits', name_zh: '举手露腋', tags: 'armpits, armpit', categories: [], preview: '' }],
  backgrounds: [{ id: 'b1', name: 'Beach', name_zh: '海滩', tags: 'beach, sand', categories: [], preview: '' }],
  clothings: [{ id: 'c1', name: 'Sailor Uniform', name_zh: '水手服', tags: 'sailor dress, serafuku', categories: [], preview: '' }],
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
    character: 'hatsune miku', pose: 'p1', background: 'b1', clothing: 'c1',
    artists: ['dairi', 'ebifurya'], custom: [],
  },
  DATA,
  'masterpiece',
);
ok('画师带 @ 前缀', composed.indexOf('@dairi, @ebifurya') === 0, composed);
ok('顺序 = 画师 → 角色 → 服装 → 环境 → 姿势 → 自定义',
  composed === '@dairi, @ebifurya, hatsune miku, sailor dress, serafuku, beach, sand, armpits, armpit, masterpiece, ', composed);
ok('结尾带 ", "（要接下游的字，不能粘住）', composed.endsWith(', '), composed.slice(-4));
const none: TagDraw = { character: '', pose: '', background: '', clothing: '', artists: [], custom: [] };
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

console.log(failed === 0 ? '\nALL PASS' : '\nFAILED ' + failed);
process.exit(failed === 0 ? 0 : 1);
