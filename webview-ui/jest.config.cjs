/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
	preset: "ts-jest",
	testEnvironment: "jsdom",
	injectGlobals: true,
	moduleFileExtensions: ["ts", "tsx", "js", "jsx", "json", "node"],
	transform: { "^.+\\.(ts|tsx)$": ["ts-jest", { tsconfig: { jsx: "react-jsx", module: "ESNext" } }] },
	testMatch: ["<rootDir>/src/**/__tests__/**/*.{js,jsx,ts,tsx}", "<rootDir>/src/**/*.{spec,test}.{js,jsx,ts,tsx}"],
	setupFilesAfterEnv: ["<rootDir>/src/setupTests.ts"],
	moduleNameMapper: {
		"\\.(css|less|scss|sass)$": "identity-obj-proxy",
		"^vscrui$": "<rootDir>/src/__mocks__/vscrui.ts",
		"^@vscode/webview-ui-toolkit/react$": "<rootDir>/src/__mocks__/@vscode/webview-ui-toolkit/react.ts",
		"^@/(.*)$": "<rootDir>/src/$1",
		"^src/i18n/setup$": "<rootDir>/src/__mocks__/i18n/setup.ts",
		"^\\.\\./setup$": "<rootDir>/src/__mocks__/i18n/setup.ts",
		"^\\./setup$": "<rootDir>/src/__mocks__/i18n/setup.ts",
		"^src/i18n/TranslationContext$": "<rootDir>/src/__mocks__/i18n/TranslationContext.tsx",
		"^\\.\\./TranslationContext$": "<rootDir>/src/__mocks__/i18n/TranslationContext.tsx",
		"^\\./TranslationContext$": "<rootDir>/src/__mocks__/i18n/TranslationContext.tsx"
	},
	reporters: [["jest-simple-dot-reporter", {}]],
	transformIgnorePatterns: [
		"/node_modules/(?!(rehype-highlight|react-remark|unist-util-visit|unist-util-find-after|vfile|unified|bail|is-plain-obj|trough|vfile-message|unist-util-stringify-position|mdast-util-from-markdown|mdast-util-to-string|micromark|decode-named-character-reference|character-entities|markdown-table|zwitch|longest-streak|escape-string-regexp|unist-util-is|hast-util-to-text|@vscode/webview-ui-toolkit|@microsoft/fast-react-wrapper|@microsoft/fast-element|@microsoft/fast-foundation|@microsoft/fast-web-utilities|exenv-es6|vscrui)/)",
	],
	roots: ["<rootDir>/src"],
	moduleDirectories: ["node_modules", "src"],
}
