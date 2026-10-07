import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // Web(plan-a-work)에서 가져온 공용 코드는 원본 규칙을 따른다 — 여기서 고치지 않는다(docs/vendored-code.md).
  { ignores: ['dist', 'src-tauri', 'src/vendor/**'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: { ecmaVersion: 2021, globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // 화면이 SQL 을 직접 쓰지 않는다 — DB 는 Rust 명령으로만.
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[value=/^\\s*(SELECT|INSERT|UPDATE|DELETE)\\s/i]',
          message: 'React 코드에 SQL 을 쓰지 않습니다. src/tauri/api.ts 의 typed 명령을 쓰세요.',
        },
      ],
    },
  },
);
