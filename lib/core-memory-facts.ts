/**
 * Core memory only sees long-term entries unless the caller also passes the
 * character card. These helpers keep that card as a check, and drop a start
 * age the model invented by turning "for N years" into "since age N".
 */

const AGE_TOKEN = String.raw`(?:\d{1,3}|[零〇一二三四五六七八九十两]{1,6})`;
const CARD_FACT_LINE = /岁|年龄|出生|年级|周岁/;

function startAgePattern(): RegExp {
    return new RegExp(
        String.raw`(?:从|自|自从)\s*${AGE_TOKEN}\s*岁\s*(?:开始|起)?|(?:开始于|始于)\s*${AGE_TOKEN}\s*岁|${AGE_TOKEN}\s*岁\s*(?:开始|起|就开始)|${AGE_TOKEN}\s*岁那年|起始年龄\s*[为是:：]?\s*${AGE_TOKEN}\s*岁`,
        "g",
    );
}

function ageMentionPattern(): RegExp {
    return new RegExp(String.raw`${AGE_TOKEN}\s*岁`, "g");
}

const CN_DIGIT: Record<string, number> = {
    零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

export function parseAgeToken(token: string): number | null {
    const text = token.trim();
    if (/^\d{1,3}$/.test(text)) {
        const value = Number(text);
        return value <= 150 ? value : null;
    }
    if (text === "十") return 10;
    const ten = text.match(/^([一二三四五六七八九两])?十([一二三四五六七八九])?$/);
    if (ten) {
        const tens = ten[1] ? CN_DIGIT[ten[1]] : 1;
        const ones = ten[2] ? CN_DIGIT[ten[2]] : 0;
        return tens * 10 + ones;
    }
    if (text.length === 1 && text in CN_DIGIT) return CN_DIGIT[text];
    return null;
}

function agesMentionedWithSui(text: string): Set<number> {
    const ages = new Set<number>();
    for (const match of text.matchAll(ageMentionPattern())) {
        const token = match[0].replace(/\s*岁$/, "");
        const age = parseAgeToken(token);
        if (age != null) ages.add(age);
    }
    return ages;
}

function tidyMemoryProse(text: string): string {
    const cleaned = text
        .replace(/[ \t]{2,}/g, " ")
        .replace(/([，,、])\1+/g, "$1")
        .replace(/([，,、])([。；;！!？?])/g, "$2")
        .replace(/^[，,、。；;！!？?\s]+/gm, "")
        .replace(/[。]{2,}/g, "。")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    return /[0-9A-Za-z\u4e00-\u9fff]/.test(cleaned) ? cleaned : "";
}

/**
 * Remove "从十一岁开始" when the long-term text never says that age.
 * "十一年" does not count: a duration is not a starting age.
 * An age that appears only on the character card is also not evidence.
 */
export function stripUngroundedStartAges(summary: string, sourceText: string): string {
    if (!summary.trim()) return "";
    const grounded = agesMentionedWithSui(sourceText);
    const stripped = summary.replace(startAgePattern(), (phrase) => {
        const token = phrase.match(new RegExp(AGE_TOKEN))?.[0] ?? "";
        const age = parseAgeToken(token);
        if (age == null) return "";
        return grounded.has(age) ? phrase : "";
    });
    return tidyMemoryProse(stripped);
}

export function formatCharacterCardFacts(input: { persona?: string; personality?: string } | null): string {
    const persona = input?.persona?.trim() ?? "";
    const personality = input?.personality?.trim() ?? "";
    if (!persona && !personality) return "（人物卡没有人设文本）";

    const factLines = persona
        .split(/\n+/)
        .map((line) => line.trim())
        .filter((line) => line && CARD_FACT_LINE.test(line))
        .slice(0, 12);

    const parts: string[] = [];
    if (personality) parts.push(`性格：${personality.slice(0, 400)}`);
    if (factLines.length) parts.push(`含年龄或出身的原文：\n${factLines.join("\n").slice(0, 1200)}`);
    if (persona) parts.push(`人设摘录：\n${persona.slice(0, 800)}`);
    return parts.join("\n\n").slice(0, 2000);
}

export const CORE_MEMORY_FACT_RULE = `事实约束（必须遵守，覆盖上面模板里与此冲突的要求）：
- 人物卡只用来核对，不要把卡上有、但这次长期记忆原文没有的经历写进总结。
- 原文没有写的年龄、起始岁数、起始年份，不要补。
- 「坚持了十一年」「十一年的习惯」只表示持续了十一年，不是从十一岁开始。
- 人物卡里的当前年龄如果和某句推算对不上，删掉这句推算，保留原文里的持续时间。
- 不要写不确定或推测的内容。
- 梦、计划、约定、假设都**不是已经发生的事**。原文写「梦到」「打算」「如果」的，必须照原样写明，不能改写成现实。
- 用具体经历代替空泛感想：「一起重装过书房的灯」可以写，「彼此更加信任、关系更加温暖」这类没有事实支撑的感想不要单独写。
- 人物卡的基础设定（身份、外貌、出身、性格设定）属于角色设定，不属于「和用户相处的记忆」。不要把设定改写成两个人之间发生过的事。`;
