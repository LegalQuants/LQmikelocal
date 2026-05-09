/**
 * Smoke test for marker emission in extractDocxBodyText.
 *
 * Run with:  npx tsx backend/scripts/smoke-marker-extraction.ts
 *
 * No formal test runner is configured for this project, so this script
 * builds minimal in-memory DOCX fixtures via JSZip and asserts the
 * extractor emits {++…++} / {--…--} / {>>by AUTHOR: …<<} markers in the
 * expected positions. Exits non-zero on any failure.
 */
import JSZip from "jszip";
import { extractDocxBodyText } from "../src/lib/docxTrackedChanges";

const W_NS =
    'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

function wrapDocXml(bodyXml: string): string {
    return (
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<w:document ${W_NS}><w:body>${bodyXml}</w:body></w:document>`
    );
}

function wrapCommentsXml(commentsXml: string): string {
    return (
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<w:comments ${W_NS}>${commentsXml}</w:comments>`
    );
}

async function buildDocx(
    documentBody: string,
    comments?: string,
): Promise<Buffer> {
    const zip = new JSZip();
    zip.file("word/document.xml", wrapDocXml(documentBody));
    if (comments) zip.file("word/comments.xml", wrapCommentsXml(comments));
    const u8 = await zip.generateAsync({ type: "uint8array" });
    return Buffer.from(u8);
}

let failures = 0;
function check(name: string, actual: string, expected: string | RegExp) {
    const ok =
        typeof expected === "string"
            ? actual === expected
            : expected.test(actual);
    if (ok) {
        console.log(`  PASS  ${name}`);
    } else {
        failures++;
        console.log(`  FAIL  ${name}`);
        console.log(`        expected: ${String(expected)}`);
        console.log(`        actual:   ${JSON.stringify(actual)}`);
    }
}

async function run() {
    console.log("smoke-marker-extraction");

    // 1. Plain paragraph — no markers, no change vs. baseline
    {
        const docx = await buildDocx(
            `<w:p><w:r><w:t xml:space="preserve">Hello world.</w:t></w:r></w:p>`,
        );
        const text = await extractDocxBodyText(docx);
        check("plain paragraph", text, "Hello world.");
    }

    // 2. Single tracked insertion → {++…++}
    {
        const docx = await buildDocx(
            `<w:p>` +
                `<w:r><w:t xml:space="preserve">The quick </w:t></w:r>` +
                `<w:ins w:id="1" w:author="Alice" w:date="2026-05-09T00:00:00Z">` +
                `<w:r><w:t xml:space="preserve">brown </w:t></w:r>` +
                `</w:ins>` +
                `<w:r><w:t xml:space="preserve">fox.</w:t></w:r>` +
                `</w:p>`,
        );
        const text = await extractDocxBodyText(docx);
        check(
            "tracked insertion emits {++…++}",
            text,
            "The quick {++brown ++}fox.",
        );
    }

    // 3. Single tracked deletion → {--…--}
    {
        const docx = await buildDocx(
            `<w:p>` +
                `<w:r><w:t xml:space="preserve">A </w:t></w:r>` +
                `<w:del w:id="2" w:author="Bob" w:date="2026-05-09T00:00:00Z">` +
                `<w:r><w:delText xml:space="preserve">very </w:delText></w:r>` +
                `</w:del>` +
                `<w:r><w:t xml:space="preserve">long sentence.</w:t></w:r>` +
                `</w:p>`,
        );
        const text = await extractDocxBodyText(docx);
        check(
            "tracked deletion emits {--…--}",
            text,
            "A {--very --}long sentence.",
        );
    }

    // 4. Word comment → {>>by AUTHOR: body<<}
    {
        const body =
            `<w:p>` +
            `<w:commentRangeStart w:id="0"/>` +
            `<w:r><w:t xml:space="preserve">Note this clause.</w:t></w:r>` +
            `<w:commentRangeEnd w:id="0"/>` +
            `<w:r><w:commentReference w:id="0"/></w:r>` +
            `</w:p>`;
        const comments =
            `<w:comment w:id="0" w:author="Carol" w:date="2026-05-09T00:00:00Z" w:initials="C">` +
            `<w:p><w:r><w:t xml:space="preserve">Confirm with client.</w:t></w:r></w:p>` +
            `</w:comment>`;
        const docx = await buildDocx(body, comments);
        const text = await extractDocxBodyText(docx);
        check(
            "comment reference emits {>>by AUTHOR: body<<}",
            text,
            "Note this clause.{>>by Carol: Confirm with client.<<}",
        );
    }

    // 5. Comment with multi-paragraph body — paragraphs concatenated when text-only
    {
        const body =
            `<w:p><w:r><w:t xml:space="preserve">See note.</w:t></w:r>` +
            `<w:r><w:commentReference w:id="7"/></w:r></w:p>`;
        const comments =
            `<w:comment w:id="7" w:author="Dana" w:date="2026-05-09T00:00:00Z">` +
            `<w:p><w:r><w:t xml:space="preserve">First line.</w:t></w:r></w:p>` +
            `<w:p><w:r><w:t xml:space="preserve">Second line.</w:t></w:r></w:p>` +
            `</w:comment>`;
        const docx = await buildDocx(body, comments);
        const text = await extractDocxBodyText(docx);
        check(
            "multi-paragraph comment body collected",
            text,
            "See note.{>>by Dana: First line. Second line.<<}",
        );
    }

    // 6. Insertion containing a comment reference — both markers render
    {
        const body =
            `<w:p>` +
            `<w:r><w:t xml:space="preserve">Add: </w:t></w:r>` +
            `<w:ins w:id="3" w:author="Eve" w:date="2026-05-09T00:00:00Z">` +
            `<w:r><w:t xml:space="preserve">payment terms</w:t><w:commentReference w:id="0"/></w:r>` +
            `</w:ins>` +
            `<w:r><w:t xml:space="preserve">.</w:t></w:r>` +
            `</w:p>`;
        const comments =
            `<w:comment w:id="0" w:author="Frank" w:date="2026-05-09T00:00:00Z">` +
            `<w:p><w:r><w:t xml:space="preserve">net 30 ok?</w:t></w:r></w:p>` +
            `</w:comment>`;
        const docx = await buildDocx(body, comments);
        const text = await extractDocxBodyText(docx);
        check(
            "comment inside insertion: both markers emit",
            text,
            "Add: {++payment terms{>>by Frank: net 30 ok?<<}++}.",
        );
    }

    // 7. Missing author falls back to "unknown"
    {
        const body =
            `<w:p>` +
            `<w:ins w:id="9" w:date="2026-05-09T00:00:00Z">` +
            `<w:r><w:t xml:space="preserve">x</w:t></w:r>` +
            `</w:ins>` +
            `</w:p>`;
        const docx = await buildDocx(body);
        const text = await extractDocxBodyText(docx);
        check("insertion without author still emits marker", text, "{++x++}");
    }

    if (failures > 0) {
        console.log(`\n${failures} failure(s).`);
        process.exit(1);
    }
    console.log("\nAll checks passed.");
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
