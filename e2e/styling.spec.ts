import { expect, test } from "./fixtures.js";

// The look itself is checked by screenshots in review (docs/ui.md); these check what a screenshot
// can't: that the faces come from Cronk itself, and that every colour comes from a token.

test("the IBM Plex faces load from Cronk itself, never from another host", async ({ page, cronk }) => {
  const hosts = new Set<string>();
  const fonts: string[] = [];
  page.on("request", (request) => {
    hosts.add(new URL(request.url()).host);
    if (request.resourceType() === "font") fonts.push(request.url());
  });

  await page.goto(cronk.url);
  await expect(page.getByRole("heading", { name: "Set up Cronk" })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);

  expect([...hosts]).toEqual([new URL(cronk.url).host]);
  expect(fonts.length).toBeGreaterThan(0);
  const loaded = await page.evaluate(() =>
    [...document.fonts].filter((face) => face.status === "loaded").map((face) => face.family.replaceAll('"', "")),
  );
  expect(loaded).toContain("IBM Plex Sans");

  // The mono face, for Ticket keys, model labels and Markdown sources, is served the same way.
  const mono = await page.evaluate(async () => (await document.fonts.load('14px "IBM Plex Mono"')).length);
  expect(mono).toBeGreaterThan(0);
  expect([...hosts]).toEqual([new URL(cronk.url).host]);
});

// docs/ui.md: components use only tokens, never literal colours. Read from the stylesheets the browser was served.
test("every colour the stylesheets set comes from a token", async ({ page, cronk }) => {
  await page.goto(cronk.url);
  await expect(page.getByRole("heading", { name: "Set up Cronk" })).toBeVisible();
  const literals = await page.evaluate(() => {
    const keywords = new Set(["transparent", "currentcolor", "inherit", "initial", "unset", "revert", "none"]);
    const found: string[] = [];
    const visit = (rules: CSSRuleList) => {
      for (const rule of rules) {
        if ("cssRules" in rule && !(rule instanceof CSSStyleRule)) visit((rule as CSSGroupingRule).cssRules);
        if (!("style" in rule)) continue;
        const style = (rule as CSSStyleRule).style;
        for (const property of style) {
          if (property.startsWith("--")) continue; // the tokens themselves
          const value = style.getPropertyValue(property);
          const words = value.replace(/var\([^)]*\)/g, " ").match(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|o?lab|o?lch|color|color-mix|light-dark)\([^)]*\)|[a-z]+/gi) ?? [];
          for (const word of words) {
            const clear = /^rgba?\(\s*0,\s*0,\s*0,\s*0\s*\)$/.test(word); // how the browser writes transparent
            if (!clear && !keywords.has(word.toLowerCase()) && CSS.supports("color", word)) {
              found.push(`${(rule as CSSStyleRule).selectorText ?? (rule as CSSKeyframeRule).keyText} { ${property}: ${value} }`);
            }
          }
        }
      }
    };
    for (const sheet of document.styleSheets) visit(sheet.cssRules);
    return found;
  });
  expect(literals).toEqual([]);
});
