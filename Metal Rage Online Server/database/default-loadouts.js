

const CANONICAL_LOADOUTS = {
    1: { body: 11100101, main: 22100101, left: 32100101, right: 31100101, booster: 41100101, skin: 61101001 },
    2: { body: 12100101, main: 26300101, left: 32100101, right: 31100101, booster: 41100101, skin: 61100101 },
    3: { body: 13100101, main: 21200101, left: 32100101, right: 31100101, booster: 41100101, skin: 61101601 },
    4: { body: 14200101, main: 24100201, left: 32100101, right: 31100101, booster: 0,        skin: 61101201 },
    5: { body: 15200101, main: 22200201, left: 32100101, right: 31100101, booster: 0,        skin: 61101301 },
    6: { body: 16200101, main: 25300101, left: 38500101, right: 0,        booster: 43100101, skin: 61101501 },
    7: { body: 17100101, main: 28100101, left: 31100101, right: 0,        booster: 42100101, skin: 61101401 },
    8: { body: 18100101, main: 28300101, left: 39100101, right: 31100101, booster: 41100101, skin: 61101101 },
};

const PART_SLOT_FIELDS = [
    ['body', 0],
    ['main', 1],
    ['left', 2],
    ['right', 3],
    ['booster', 4],
    ['skin', 5],
];

module.exports = {
    CANONICAL_LOADOUTS,
    PART_SLOT_FIELDS,
};
