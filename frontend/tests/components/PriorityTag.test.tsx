/**
 * Component suite for `PriorityTag`, the pill that renders a task's priority level as a word.
 *
 * What it pins is the accessible half of the priority tag: the level is carried by real text, so a
 * reader without colour — a monochrome display, a colour-blind reader, a screen reader walking the
 * accessibility tree — still receives `Low`, `Medium` or `High`. The colour is deliberately
 * unasserted: Vitest processes no CSS, the class `priorityModifier` produces is an implementation
 * detail shared with the stylesheet, and a pinned copy of a derived class name would break on any
 * restyle while proving nothing about the meaning.
 *
 * The suite therefore establishes four things and nothing more. Each level renders its own word;
 * that word is the tag's entire visible text, so no stray label can be mistaken for the meaning;
 * the other two levels' words are absent, so the mapping cannot pass with a constant word; and the
 * three words are pairwise distinct, which is the executable form of "priority is conveyed by text
 * as well as colour" — a colour-only implementation fails it.
 *
 * Everything here is local: it renders into jsdom, opens no socket, starts no process, touches no
 * database and stubs nothing, and it asserts solely through user-facing queries (`getByText`,
 * `queryByText`, `toBeVisible`, `toHaveTextContent`) rather than through class names or test ids.
 *
 * `describe`, `it` and `expect` are globals — `frontend/vite.config.ts` sets `test.globals: true`
 * and `frontend/tsconfig.json` types them — and the automatic cleanup hook those globals register
 * unmounts each render after its test, so no test observes another's DOM.
 */

import type { TaskPriority } from '../../src/api/types';
import { PriorityTag } from '../../src/components/PriorityTag';
import { renderUi, screen } from '../support/helpers';

/**
 * Every priority level with the word it must render.
 *
 * A `readonly` table rather than three hand-written cases so no array is indexed by hand — under
 * `noUncheckedIndexedAccess` an indexed read would widen to `TaskPriority | undefined` — and so a
 * level outside the wire union fails `tsc` here instead of never being rendered.
 *
 * The words are the exact casing the interface displays, asserted case-sensitively: the tag is the
 * only place the level is spelled out, so a lowercase `low` has to fail rather than pass a laxer
 * query.
 */
const LEVEL_WORDS: ReadonlyArray<readonly [TaskPriority, string]> = [
  ['low', 'Low'],
  ['medium', 'Medium'],
  ['high', 'High'],
];

/**
 * The trimmed text of the tag rendering `word`.
 *
 * Reads the element the query found rather than the document, so the comparison is against the
 * tag's own copy, and narrows `textContent` by asserting it exists instead of silencing the
 * compiler: a tag that rendered no text at all fails here with a named word.
 */
function tagText(word: string): string {
  const tag = screen.getByText(word);
  const text = tag.textContent?.trim();

  if (text === undefined) {
    throw new Error(`Expected the tag for "${word}" to render text.`);
  }

  return text;
}

describe('PriorityTag', () => {
  it.each(LEVEL_WORDS)('%s renders its word %s', (level, word) => {
    renderUi(<PriorityTag priority={level} />);

    const tag = screen.getByText(word);

    // Real, visible text rather than a hidden or colour-only signal: this is the word a screen
    // reader announces and the word a monochrome display still shows.
    expect(tag).toBeInTheDocument();
    expect(tag).toBeVisible();
    expect(tag).toHaveTextContent(word);

    // The word is the tag's whole text, so the meaning is that word and nothing beside it.
    expect(tagText(word)).toBe(word);

    // Neither of the other two levels is rendered, so the level-to-word mapping is per-level.
    const otherWords = LEVEL_WORDS.filter(([otherLevel]) => otherLevel !== level).map(
      ([, otherWord]) => otherWord,
    );

    expect(otherWords).toHaveLength(2);
    for (const otherWord of otherWords) {
      expect(screen.queryByText(otherWord)).toBeNull();
    }
  });

  it('renders three pairwise distinct words across the levels', () => {
    renderUi(
      <>
        {LEVEL_WORDS.map(([level]) => (
          <PriorityTag key={level} priority={level} />
        ))}
      </>,
    );

    // A repeated word would make one of these queries match two tags and fail before the
    // comparison below, and the three literals it compares against are all different.
    const words = LEVEL_WORDS.map(([, word]) => tagText(word));

    expect(words).toHaveLength(3);
    expect([...words].sort()).toEqual(['High', 'Low', 'Medium']);
  });
});
