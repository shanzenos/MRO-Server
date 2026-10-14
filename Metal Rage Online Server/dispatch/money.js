

const MONEY_MAX = 2147483647;

function clampMoney(value, fallback = 0)
{
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.min(MONEY_MAX, Math.max(0, Math.trunc(numeric)));
}

function moneyBigInt(value, fallback = 0)
{
    return BigInt(clampMoney(value, fallback));
}

module.exports = {
    MONEY_MAX,
    clampMoney,
    moneyBigInt,
};
