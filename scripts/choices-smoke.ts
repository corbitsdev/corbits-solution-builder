/**
 * Choices smoke: every form a specialist has used to offer a choice is found,
 * and the forms that are not choices are left alone.
 *
 * Usage: bun scripts/choices-smoke.ts
 */
import { choicesIn } from "../apps/web/src/pages/workspace/choices.js";

const checks: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const kit = choicesIn(
  "The brief now says what the pain is.\n\nDoes a shared data format already exist, meaning a spec other systems read?\n- Option: One exists, I can point you at it\n- Option: Nothing exists yet\n- Option: Not sure",
);
check(
  "the kit's own form",
  kit !== null &&
    kit.question.startsWith("Does a shared") &&
    same(kit.options, ["One exists, I can point you at it", "Nothing exists yet", "Not sure"]) &&
    kit.before === "The brief now says what the pain is.",
  JSON.stringify(kit),
);

const numbered = choicesIn("Three ways to bound this.\n\nWhich approach do you prefer?\n\n1. Ship the spreadsheet importer first\n2. Build the API and skip import\n3) Both, sequenced");
check(
  "numbered, with a blank line after the question",
  numbered !== null && numbered.question === "Which approach do you prefer?" && numbered.options.length === 3 && numbered.options[2] === "Both, sequenced",
  JSON.stringify(numbered),
);

const lettered = choicesIn("Here are the options.\n\n**A.** Keep the nightly batch\nB) Move to streaming\n(c) Do both for a quarter\n\nWhich one fits?");
check(
  "lettered and bold, question closing the list",
  lettered !== null && lettered.question === "Which one fits?" && same(lettered.options, ["Keep the nightly batch", "Move to streaming", "Do both for a quarter"]) && lettered.before === "Here are the options.",
  JSON.stringify(lettered),
);

const named = choicesIn("Which do you want?\n- **Option A: Importer first** — least risk\n- **Option B: API first** — most reach");
check(
  "an option's own name is kept",
  named !== null && named.options[0] === "Option A: Importer first — least risk",
  JSON.stringify(named),
);

check("a list with no question is not a choice", choicesIn("Done so far:\n- Read the brief\n- Drafted the scope") === null);
check("one item is not a choice", choicesIn("Which?\n- Only this") === null);
check("a question on its own is not a choice", choicesIn("Is that right?") === null);
check("seven items is a list, not a choice", choicesIn("Which?\n" + Array.from({ length: 7 }, (_, at) => `${at + 1}. Thing ${at + 1}`).join("\n")) === null);
check("prose after the list is not a choice", choicesIn("Which?\n1. A\n2. B\nThat is all I have.") === null);

const failed = checks.filter((entry) => !entry.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
if (failed.length > 0) process.exit(1);
