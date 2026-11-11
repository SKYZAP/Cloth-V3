import CodeMirror from '@uiw/react-codemirror'
import { markdown } from '@codemirror/lang-markdown'
import { json } from '@codemirror/lang-json'
import { javascript } from '@codemirror/lang-javascript'
import { EditorView } from '@codemirror/view'

const theme = EditorView.theme(
  {
    '&': { color: '#f1f1f4', backgroundColor: 'transparent' },
    '.cm-content': { caretColor: '#e54056', padding: '12px 0' },
    '.cm-cursor': { borderLeftColor: '#e54056' },
    '.cm-gutters': { backgroundColor: 'transparent', color: '#4a4a52', border: 'none' },
    '.cm-activeLine': { backgroundColor: 'rgb(255 255 255 / 0.025)' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: '#bdbdc5' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'rgb(207 40 69 / 0.28) !important' },
    '.cm-line': { padding: '0 14px' }
  },
  { dark: true }
)

export function Editor({
  value,
  onChange,
  lang = 'markdown',
  height = '100%',
  readOnly,
  placeholder
}: {
  value: string
  onChange?(v: string): void
  lang?: 'markdown' | 'json' | 'javascript' | 'text'
  height?: string
  readOnly?: boolean
  placeholder?: string
}) {
  const extensions = [EditorView.lineWrapping, theme, ...(lang === 'markdown' ? [markdown()] : lang === 'json' ? [json()] : lang === 'javascript' ? [javascript()] : [])]
  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      height={height}
      theme="dark"
      readOnly={readOnly}
      placeholder={placeholder}
      extensions={extensions}
      basicSetup={{ foldGutter: false, highlightActiveLineGutter: true, lineNumbers: true, autocompletion: false }}
      className="h-full"
    />
  )
}
