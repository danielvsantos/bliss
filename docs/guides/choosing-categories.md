# Choosing the Right Category

Bliss ships with a comprehensive set of default categories organized into 9 types: **Income, Essentials, Lifestyle, Growth, Ventures, Investments, Asset, Debt, Transfers**. Most transactions fit obviously into one category — groceries go in Essentials → Groceries, salary goes in Income → Labor Income → Salary. This guide covers the cases where the right category isn't obvious.

> **Look for the info icon (ⓘ).** In the category picker and on the Categories page, ambiguous categories show a description tooltip explaining when to use them. Hover the icon (or read the subtitle on the Categories page) before picking.

## Common ambiguities

### Transfers (Sent / Received Domestic / International)

Use these when money moves **without a clear purchase or income context**. Typical cases:

- Moving money between your own accounts (when only one is tracked in Bliss)
- Wires to or from family
- Sending or receiving money to/from a friend when you don't remember (or don't want to track) what it was for

Domestic vs International is just whether the transfer crossed a border. The `Sent` / `Received` direction matches whether money left or entered your account.

**If you know what the transfer is for, use the category of the original event instead.** Example: you bought concert tickets for $200 (categorized under Entertainment) and your friend Venmos you $100 back — categorize their payback as Entertainment too, so the net Entertainment spend ends up at $100. Sent/Received Domestic is the fallback for transfers you can't or don't want to attribute.

If both your accounts are tracked in Bliss, ideally you'd link the two sides of an internal transfer so they net to zero — but if only one side is in Bliss, `Sent Domestic` (or its International cousin) is correct.

### Service Revenue (Ventures) vs Freelance Income (Labor)

Both are "I provided a service and got paid." The difference is **how you treat the activity**:

- **Freelance Income** (Income → Labor Income) — Use when freelancing/consulting is your **main job**. You don't track separate business expenses; you just want to record what came in.
- **Service Revenue** (Ventures → Service Revenue) — Use when the work is a **separate business or side project** with its own P&L. You're tracking revenue, costs, taxes, and people separately, and want to see the venture's profitability on its own.

A pure freelancer reports income under Labor. A consultant running their practice as a registered business with its own books should use Ventures.

### Inheritance

`Inheritance` lives under **Transfers**, not Income. The reasoning: it's a one-time windfall, not labor or investment return, and folding it into Income would distort yearly income trends — a $200k inheritance year would dwarf normal salary patterns. Treating it as a Transfer keeps your income-vs-spending baseline clean while still capturing the net-worth impact.

The same logic will apply to future windfall categories (gifts received, lottery, large refunds).

### Allowance

`Allowance` is for **pocket money, parental allowances, or ongoing family support**. Two main use cases:

- Students and young adults receiving regular family support
- Bliss-in-the-classroom deployments where teachers help students track money received

If you're an independent adult, you probably won't use this category — but it's there for users who need it.

### Government Welfare vs Tax Refund

- **Government Welfare** (Passive Income) — Unemployment benefits, child benefits, social security, disability payments. These are government transfers, not labor income.
- **Tax Refund** (Taxes) — Money returned by the tax authority for over-payment in a prior period.

Both are money in, but they have very different mental models — keep them separate so they don't pollute each other's trends.

## Custom categories

If none of the defaults fit, create a custom category from the Categories page:

1. Pick a **type** (one of the 9 fixed types — these are immutable)
2. Pick or create a **group** (free-text, scoped to the type)
3. Set a **name**, optional **icon**, and **description**

The description you write will show up as a tooltip in the category picker, helping you (and anyone else on the same tenant) pick consistently in the future. Investing 30 seconds to write a clear description pays back every time the AI or another user has to make a judgment call.

## When the AI gets it wrong

The 4-tier AI classifier ([details](/docs/guides/ai-classification)) learns from your corrections. When you override a category in the review step or after import, that mapping is stored immediately and applied to future identical transactions. Over time, ambiguous merchants get classified the way *you* want them.

If you're consistently fighting the AI on a specific category, check whether a description on that category would help disambiguate it the next time the LLM has to choose.
