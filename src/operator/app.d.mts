/**
 * `app.mjs` is the console's entry point: it has no exports and self-boots on
 * import. This declaration exists so a test can import it for its side effects
 * under `verbatimModuleSyntax` — see `test/operator/certify-view.test.ts`, which
 * runs the real page against a DOM double rather than grepping its source.
 */
export {};
