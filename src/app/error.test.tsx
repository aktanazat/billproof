import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import PageError from "./error";

// The error page replaces what broke, and with it whatever had focus; its heading takes focus when it appears, as a
// result's does, so a screen reader says what happened. That needs a heading that allows focus.
test("the error page's heading can take focus when the page appears", () => {
  const html = renderToStaticMarkup(createElement(PageError, { error: new Error("test"), reset: () => {} }));
  expect(html).toMatch(/<h1[^>]*tabindex="-1"[^>]*>Something went wrong showing this page<\/h1>/);
});
