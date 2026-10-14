'use strict';

const { moneyBigInt } = require('./money');

function writeRecordInfoBody(body, fields)
{
    for (let i = 0; i < 0x60; i += 4) body.writeUInt32LE(0, i);
    body.writeUInt32LE(fields.level, 0x00);
    body.writeBigUInt64LE(moneyBigInt(fields.coupon, 0), 0x14);
    body.writeUInt32LE(fields.wins, 0x1c);
    body.writeUInt32LE(fields.draws, 0x20);
    body.writeUInt32LE(fields.losses, 0x24);
    body.writeUInt32LE(fields.kills, 0x28);
    body.writeUInt32LE(fields.deaths, 0x2c);
    body.writeBigUInt64LE(BigInt(fields.exp), 0x40);
    body.writeBigUInt64LE(moneyBigInt(fields.point, 100000), 0x48);
}

module.exports = { writeRecordInfoBody };
