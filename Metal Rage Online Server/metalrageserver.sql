-- =============================================
-- Metal Rage Online - Complete Database Setup
-- =============================================
-- Run this to create/reset the entire database.
-- WARNING: This drops and recreates all tables!
--
-- Compatible with MySQL 5.5+ (uses TIMESTAMP, no IF NOT EXISTS on procedures)
--
-- Item IDs extracted from Cache.Bin (real game data)
-- Wire format confirmed from ZNetwork.dll disassembly
-- =============================================

CREATE DATABASE IF NOT EXISTS mro;
USE mro;

-- Drop existing tables (in reverse dependency order)
DROP TABLE IF EXISTS friends;
DROP TABLE IF EXISTS maps;
DROP TABLE IF EXISTS tutorials;
DROP TABLE IF EXISTS items;
DROP TABLE IF EXISTS mech_licenses;
DROP TABLE IF EXISTS mech_levels;
DROP TABLE IF EXISTS records;
DROP TABLE IF EXISTS item_catalog;
DROP TABLE IF EXISTS accounts;

-- =============================================
-- ACCOUNTS - Core player identity
-- Sent in: SN_DEFAULT_INFO (0x210101)
-- =============================================
CREATE TABLE accounts (
    id              INT UNSIGNED    AUTO_INCREMENT PRIMARY KEY,
    username        VARCHAR(25)     NOT NULL UNIQUE,
    nickname        VARCHAR(25)     NOT NULL UNIQUE,
    pilot           INT UNSIGNED    NOT NULL DEFAULT 101,
    account_level   TINYINT         NOT NULL DEFAULT 1,
    gender          TINYINT         NOT NULL DEFAULT 1,
    created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_login      TIMESTAMP       NULL DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- =============================================
-- RECORDS - Player stats
-- Sent in: SN_RECORD_INFO (0x210103)
-- =============================================
CREATE TABLE records (
    account_id      INT UNSIGNED    PRIMARY KEY,
    level           INT UNSIGNED    NOT NULL DEFAULT 1,
    exp             BIGINT UNSIGNED NOT NULL DEFAULT 0,
    exp_max         BIGINT UNSIGNED NOT NULL DEFAULT 1000,
    wins            INT UNSIGNED    NOT NULL DEFAULT 0,
    losses          INT UNSIGNED    NOT NULL DEFAULT 0,
    draws           INT UNSIGNED    NOT NULL DEFAULT 0,
    kills           INT UNSIGNED    NOT NULL DEFAULT 0,
    deaths          INT UNSIGNED    NOT NULL DEFAULT 0,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- =============================================
-- MECH_LEVELS - Per-mech experience and stats
-- Sent in: SN_MECH_LEVEL (0x210104)
-- =============================================
CREATE TABLE mech_levels (
    account_id      INT UNSIGNED    NOT NULL,
    mech_type       TINYINT         NOT NULL,
    level           INT UNSIGNED    NOT NULL DEFAULT 1,
    exp             BIGINT UNSIGNED NOT NULL DEFAULT 0,
    kills           INT UNSIGNED    NOT NULL DEFAULT 0,
    deaths          INT UNSIGNED    NOT NULL DEFAULT 0,
    sorties         INT UNSIGNED    NOT NULL DEFAULT 0,
    PRIMARY KEY (account_id, mech_type),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- =============================================
-- MECH_LICENSES - Which mechs the player can use
-- Sent in: SN_LICENSE_INFO (0x260101)
-- =============================================
CREATE TABLE mech_licenses (
    account_id      INT UNSIGNED    NOT NULL,
    slot            TINYINT         NOT NULL,
    mech_type       TINYINT         NOT NULL,
    license_type    TINYINT         NOT NULL DEFAULT 0,
    PRIMARY KEY (account_id, slot),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- =============================================
-- ITEMS - Player inventory (weapons, parts, etc.)
-- Sent in: SN_ITEM_INFO (0x210111)
--
-- Wire format (confirmed from ZNetwork.dll disassembly):
--   Header: u8 SuccessFlag, u8 ItemCount, u32 AccountKey
--   Per-item: 35 bytes (0x23)
--     u32 UniqueKey (= items.id)
--     u32 ItemIndex (= items.item_id, from Cache.Bin)
--     u32 EquipStatus (1=equipped)
--     + additional fields
--
-- Item ID format from Cache.Bin: XXYYZZ01
--   2XXXXXXX = Main Weapons
--   3XXXXXXX = Assist Weapons
--   4XXXXXXX = Boosters & Support
-- =============================================
CREATE TABLE items (
    id              INT UNSIGNED    AUTO_INCREMENT PRIMARY KEY,
    account_id      INT UNSIGNED    NOT NULL,
    item_id         INT UNSIGNED    NOT NULL,
    slot            TINYINT         NOT NULL DEFAULT 0,
    mech_type       TINYINT         NOT NULL DEFAULT 0,
    part_slot       TINYINT         NOT NULL DEFAULT 0,
    quantity        INT UNSIGNED    NOT NULL DEFAULT 1,
    equipped        TINYINT         NOT NULL DEFAULT 0,
    INDEX idx_account (account_id),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- =============================================
-- TUTORIALS
-- =============================================
CREATE TABLE tutorials (
    account_id      INT UNSIGNED    NOT NULL,
    tutorial_id     TINYINT         NOT NULL,
    completed       TINYINT         NOT NULL DEFAULT 0,
    completed_at    TIMESTAMP       NULL DEFAULT NULL,
    PRIMARY KEY (account_id, tutorial_id),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- =============================================
-- MAPS
-- =============================================
CREATE TABLE maps (
    account_id      INT UNSIGNED    NOT NULL,
    map_id          INT UNSIGNED    NOT NULL,
    PRIMARY KEY (account_id, map_id),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- =============================================
-- FRIENDS
-- =============================================
CREATE TABLE friends (
    account_id      INT UNSIGNED    NOT NULL,
    friend_id       INT UNSIGNED    NOT NULL,
    friend_type     TINYINT         NOT NULL DEFAULT 0,
    PRIMARY KEY (account_id, friend_id),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    FOREIGN KEY (friend_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- =============================================
-- ITEM CATALOG - Reference table of all known items
-- Real item IDs extracted from Cache.Bin
-- Use this to look up item codes when adding items manually
-- =============================================
CREATE TABLE item_catalog (
    item_id         INT UNSIGNED    PRIMARY KEY,
    code            VARCHAR(10)     NOT NULL,
    name            VARCHAR(50)     NOT NULL DEFAULT '',
    category        VARCHAR(20)     NOT NULL DEFAULT ''
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO item_catalog (item_id, code, name, category) VALUES
-- Main Weapons (2XXXXXXX)
(21100101, 'MOC_a', 'Smoothbore gun', 'MainWeapon'),
(21200101, 'MNC_a', 'Multi-column smoothbore', 'MainWeapon'),
(21200201, 'MNC_b', 'Multi-column smoothbore', 'MainWeapon'),
(21200301, 'MNC_c', 'Multi-column smoothbore', 'MainWeapon'),
(21300101, 'MMC_a', 'Fire cannon', 'MainWeapon'),
(21300201, 'MMC_b', 'Fire cannon', 'MainWeapon'),
(21500101, 'MRC_a', 'Range cannon', 'MainWeapon'),
(22100101, 'MOM_a', 'Cannon', 'MainWeapon'),
(22100201, 'MOM_b', 'Cannon', 'MainWeapon'),
(22200101, 'MOV_a', 'Balkan mini-cannon', 'MainWeapon'),
(22200201, 'MNV_a', 'Balkan vulcan', 'MainWeapon'),
(22300201, 'MOS_a', 'Shotgun', 'MainWeapon'),
(22500101, 'MAM_a', 'Auto machinegun', 'MainWeapon'),
(22600101, 'MOL_a', 'Laser', 'MainWeapon'),
(23100201, 'MOR_b', 'Missile Watch', 'MainWeapon'),
(23200101, 'MNR_a', 'Multi-column missile', 'MainWeapon'),
(24100101, 'MSC_a', 'Sniper rifle', 'MainWeapon'),
(24100201, 'MSC_b', 'Sniper rifle', 'MainWeapon'),
(24100301, 'MSC_c', 'Sniper rifle', 'MainWeapon'),
(24300101, 'MSG_a', 'Sniper Gather', 'MainWeapon'),
(25100101, 'MLH_a', 'Anti-aircraft fire', 'MainWeapon'),
(25200101, 'MNH_a', 'Shotgun', 'MainWeapon'),
(25300101, 'MTE_a', 'Throw ordnance', 'MainWeapon'),
(25300201, 'MTE_b', 'Throw ordnance', 'MainWeapon'),
(26300101, 'MSA_a', 'Saw Arm', 'MainWeapon'),
(26500101, 'MHA_a', 'Close range weapon', 'MainWeapon'),
(26500201, 'MFF_a', 'Flame emitter', 'MainWeapon'),
(28100101, 'MAT_a', 'Fort setting machine', 'MainWeapon'),
(28200101, 'MLT_a', 'Laser turret', 'MainWeapon'),
(28300101, 'MPF_a', 'Remote detection', 'MainWeapon'),
(28300201, 'MPF_b', 'Probe', 'MainWeapon'),
(28400101, 'MMT_a', 'Missile turret', 'MainWeapon'),
-- Assist Weapons (3XXXXXXX)
(31100101, 'AOC_a', 'Auxiliary single gun', 'AssistWeapon'),
(31100201, 'AOC_b', 'Auxiliary single gun', 'AssistWeapon'),
(32100101, 'AOM_a', 'Secondary guns', 'AssistWeapon'),
(32100201, 'AOM_b', 'Secondary guns', 'AssistWeapon'),
(33100101, 'AOR_a', 'Watch missile', 'AssistWeapon'),
(33300101, 'ANR_a', 'Multi-row missile', 'AssistWeapon'),
(33300301, 'ANG_a', 'Multi-lock', 'AssistWeapon'),
(33500101, 'AMR_a', 'Rise mine', 'AssistWeapon'),
(33500201, 'ATR_a', 'Target rocket', 'AssistWeapon'),
(35100101, 'ACH_a', 'Grenade transmitter', 'AssistWeapon'),
(35100201, 'ACH_b', 'Grenade transmitter', 'AssistWeapon'),
(38500101, 'AFM_a', 'Follow mine', 'AssistWeapon'),
(38500201, 'ARM_a', 'Rise mine', 'AssistWeapon'),
(38500301, 'ATA_a', 'Trap setting machine', 'AssistWeapon'),
(39100101, 'AEF_a', 'EMP', 'AssistWeapon'),
(39400101, 'AIF_a', 'Stealth fire', 'AssistWeapon'),
(39500101, 'AGF_a', 'Flare', 'AssistWeapon'),
(39700101, 'ANF_a', 'Jammer', 'AssistWeapon'),
-- Boosters (41XXXXXX)
(41100101, 'BPE_a', 'Plasma thrusters', 'Booster'),
(41200101, 'BHE_a', 'Hydrogen booster', 'Booster'),
(41200201, 'BHE_i', 'Hydrogen booster I', 'Booster'),
(41300101, 'BNE_a', 'Nano-propeller', 'Booster'),
-- Support (42-43XXXXXX)
(42100101, 'ADA_a', 'Repair robot', 'Support'),
(43100101, 'ABA_a', 'Construction equipment', 'Support'),
(43100201, 'ABA_b', 'Construction equipment', 'Support');

-- =============================================
-- STORED PROCEDURE - Create new player
-- Includes starter items with real Cache.Bin IDs
-- =============================================
DELIMITER //
DROP PROCEDURE IF EXISTS create_new_player //
CREATE PROCEDURE create_new_player(
    IN p_username VARCHAR(25),
    IN p_nickname VARCHAR(25),
    IN p_pilot INT UNSIGNED
)
BEGIN
    DECLARE v_id INT UNSIGNED;

    INSERT INTO accounts (username, nickname, pilot)
    VALUES (p_username, p_nickname, p_pilot);
    SET v_id = LAST_INSERT_ID();

    INSERT INTO records (account_id) VALUES (v_id);

    INSERT INTO mech_levels (account_id, mech_type) VALUES
        (v_id, 1), (v_id, 2), (v_id, 3), (v_id, 4),
        (v_id, 5), (v_id, 6), (v_id, 7), (v_id, 8);

    INSERT INTO mech_licenses (account_id, slot, mech_type, license_type) VALUES
        (v_id, 0, 1, 1), (v_id, 1, 2, 1), (v_id, 2, 3, 1), (v_id, 3, 4, 1),
        (v_id, 4, 5, 1), (v_id, 5, 6, 1), (v_id, 6, 7, 1), (v_id, 7, 8, 1);

    INSERT INTO maps (account_id, map_id) VALUES
        (v_id, 0), (v_id, 1), (v_id, 2),
        (v_id, 3), (v_id, 4), (v_id, 5);

    INSERT INTO tutorials (account_id, tutorial_id) VALUES
        (v_id, 1), (v_id, 2), (v_id, 3), (v_id, 4);

    -- Starter items: 3 per mech (Primary + Assist + Booster) = 24 items
    -- Part slots: 1=Primary, 2=Sub-weapon, 4=Booster
    INSERT INTO items (account_id, item_id, slot, mech_type, part_slot, quantity, equipped) VALUES
        (v_id, 21100101, 1, 1, 1, 1, 1),  -- Light: MOC_a Smoothbore
        (v_id, 31100101, 2, 1, 2, 1, 1),  -- Light: AOC_a Aux gun
        (v_id, 41100101, 4, 1, 4, 1, 1),  -- Light: BPE_a Plasma thrusters
        (v_id, 22100101, 1, 2, 1, 1, 1),  -- Assault: MOM_a Cannon
        (v_id, 32100101, 2, 2, 2, 1, 1),  -- Assault: AOM_a Secondary guns
        (v_id, 41200101, 4, 2, 4, 1, 1),  -- Assault: BHE_a Hydrogen booster
        (v_id, 21200101, 1, 3, 1, 1, 1),  -- Medium: MNC_a Multi-column
        (v_id, 33100101, 2, 3, 2, 1, 1),  -- Medium: AOR_a Watch missile
        (v_id, 41300101, 4, 3, 4, 1, 1),  -- Medium: BNE_a Nano-propeller
        (v_id, 24100101, 1, 4, 1, 1, 1),  -- Sniper: MSC_a Sniper rifle
        (v_id, 31100201, 2, 4, 2, 1, 1),  -- Sniper: AOC_b Aux gun
        (v_id, 41100101, 4, 4, 4, 1, 1),  -- Sniper: BPE_a Plasma thrusters
        (v_id, 25100101, 1, 5, 1, 1, 1),  -- Firepower: MLH_a Anti-aircraft
        (v_id, 35100101, 2, 5, 2, 1, 1),  -- Firepower: ACH_a Grenade
        (v_id, 41200101, 4, 5, 4, 1, 1),  -- Firepower: BHE_a Hydrogen booster
        (v_id, 28100101, 1, 6, 1, 1, 1),  -- Engineer: MAT_a Fort machine
        (v_id, 43100101, 2, 6, 2, 1, 1),  -- Engineer: ABA_a Construction
        (v_id, 42100101, 4, 6, 4, 1, 1),  -- Engineer: ADA_a Repair robot
        (v_id, 26500101, 1, 7, 1, 1, 1),  -- Maintenance: MHA_a Close range
        (v_id, 38500301, 2, 7, 2, 1, 1),  -- Maintenance: ATA_a Trap machine
        (v_id, 41300101, 4, 7, 4, 1, 1),  -- Maintenance: BNE_a Nano-propeller
        (v_id, 28300101, 1, 8, 1, 1, 1),  -- Observation: MPF_a Remote detection
        (v_id, 39100101, 2, 8, 2, 1, 1),  -- Observation: AEF_a EMP
        (v_id, 41100101, 4, 8, 4, 1, 1);  -- Observation: BPE_a Plasma thrusters

END //
DELIMITER ;
