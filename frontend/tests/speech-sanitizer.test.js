const test = require('node:test');
const assert = require('node:assert/strict');
const { stripMarkdown } = require('../speech-sanitizer.js');

test('keeps human-facing Markdown content and strips syntax', () => {
  assert.equal(
    stripMarkdown('## 作業完了\n\n- **認証**を修正\n- [PR を見る](https://example.com/pr/1)'),
    '作業完了\n認証を修正\nPR を見る',
  );
});

test('replaces code blocks but preserves inline code wording', () => {
  assert.equal(
    stripMarkdown('`cargo test` を実行しました。\n```rust\nfn main() {}\n```'),
    'cargo test を実行しました。\n（rust のコードは画面に表示しています）',
  );
});

test('handles images, tables, quotes, and HTML without leaving markers', () => {
  assert.equal(
    stripMarkdown('> ![設計図](image.png)\n\n| 状態 | 結果 |\n| --- | --- |\n| <b>OK</b> | ~~完了~~ |'),
    '設計図\n状態 、 結果\nOK 、 完了',
  );
});
