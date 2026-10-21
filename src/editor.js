// CodeMirror 6 setup for editing Haskell on an iPad.
// Bundled by scripts/build-editor.mjs into web/vendor/editor.js.
import { EditorState, Compartment, EditorSelection } from '@codemirror/state';
import {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter,
  drawSelection, highlightSpecialChars,
} from '@codemirror/view';
import {
  defaultKeymap, history, historyKeymap, indentLess, insertNewlineAndIndent,
  cursorLineUp, cursorLineDown,
} from '@codemirror/commands';
import {
  StreamLanguage, syntaxHighlighting, HighlightStyle, bracketMatching, indentUnit,
} from '@codemirror/language';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { haskell } from '@codemirror/legacy-modes/mode/haskell';
import { tags as t } from '@lezer/highlight';

// iPadOS "smart punctuation" turns ' into ’ and -- into —, which breaks Haskell.
const SMART = { '‘': "'", '’': "'", '“': '"', '”': '"', '—': '--', '–': '--' };
export function unsmart(s) {
  return s.replace(/[‘’“”–—]/g, (c) => SMART[c]);
}

const unsmartFilter = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || !tr.isUserEvent('input')) return tr;
  let changed = false;
  const specs = [];
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, text) => {
    const s = text.toString();
    const u = unsmart(s);
    if (u !== s) changed = true;
    specs.push({ from: fromA, to: toA, insert: u });
  });
  if (!changed) return tr;
  const changes = tr.startState.changes(specs);
  const end = changes.mapPos(tr.startState.selection.main.head, 1);
  return { changes, selection: EditorSelection.cursor(end), userEvent: 'input.type', scrollIntoView: true };
});

// Two-space soft tabs: what students expect from Haskell layout.
function insertSpaces(view) {
  view.dispatch(view.state.replaceSelection('  '), { scrollIntoView: true, userEvent: 'input' });
  return true;
}

const highlight = HighlightStyle.define([
  { tag: t.keyword, color: 'var(--syn-keyword)', fontWeight: '600' },
  { tag: [t.typeName, t.className, t.namespace], color: 'var(--syn-type)' },
  { tag: [t.string, t.character], color: 'var(--syn-string)' },
  { tag: [t.number, t.bool, t.atom], color: 'var(--syn-number)' },
  { tag: t.comment, color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [t.operator, t.punctuation], color: 'var(--syn-operator)' },
  { tag: t.meta, color: 'var(--syn-comment)' },
  { tag: t.variableName, color: 'var(--fg)' },
]);

const theme = EditorView.theme({
  '&': { height: '100%', color: 'var(--fg)', backgroundColor: 'var(--editor-bg)' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.35' },
  '.cm-content': { caretColor: 'var(--accent)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '3px' },
  '.cm-gutters': { backgroundColor: 'var(--gutter-bg)', color: 'var(--muted)', border: 'none' },
  '.cm-activeLine': { backgroundColor: 'var(--active-line)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--active-line)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--selection) !important' },
  '.cm-matchingBracket': { backgroundColor: 'var(--match-bg)', outline: 'none' },
  '.cm-error-line': { backgroundColor: 'var(--error-line)' },
});

export function createEditor(parent, { doc = '', onChange, onRun, onSave } = {}) {
  const fontSize = new Compartment();
  let fontPx = 20;
  const fontTheme = () => EditorView.theme({ '&': { fontSize: fontPx + 'px' } });
  const extensions = [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    highlightActiveLine(),
    bracketMatching(),
    highlightSelectionMatches(),
    indentUnit.of('  '),
    EditorState.tabSize.of(2),
    StreamLanguage.define(haskell),
    syntaxHighlighting(highlight),
    unsmartFilter,
    keymap.of([
      { key: 'Mod-Enter', run: () => { onRun && onRun(); return true; } },
      { key: 'Mod-s', run: () => { onSave && onSave(); return true; }, preventDefault: true },
      { key: 'Tab', run: insertSpaces, shift: indentLess },
      { key: 'Enter', run: insertNewlineAndIndent },
      ...defaultKeymap, ...historyKeymap, ...searchKeymap,
    ]),
    EditorView.contentAttributes.of({
      autocorrect: 'off', autocapitalize: 'off', spellcheck: 'false', autocomplete: 'off',
    }),
    EditorView.updateListener.of((u) => { if (u.docChanged && onChange) onChange(); }),
    theme,
    fontSize.of(fontTheme()),
  ];
  const view = new EditorView({ parent, state: EditorState.create({ doc, extensions }) });

  return {
    view,
    getText: () => view.state.doc.toString(),
    // Replaces the document and its undo history (used when switching files).
    setText(text) {
      view.setState(EditorState.create({ doc: text, extensions }));
    },
    setFontSize(px) {
      fontPx = px;
      view.dispatch({ effects: fontSize.reconfigure(fontTheme()) });
    },
    gotoLine(line, col = 1) {
      const n = Math.max(1, Math.min(line, view.state.doc.lines));
      const l = view.state.doc.line(n);
      const pos = Math.min(l.from + Math.max(0, col - 1), l.to);
      view.dispatch({ selection: EditorSelection.cursor(pos), scrollIntoView: true });
      view.focus();
    },
    insert(text) {
      view.dispatch(view.state.replaceSelection(text), { scrollIntoView: true, userEvent: 'input' });
      view.focus();
    },
    moveLine(dir) {
      (dir < 0 ? cursorLineUp : cursorLineDown)(view);
      view.focus();
    },
    focus: () => view.focus(),
  };
}
