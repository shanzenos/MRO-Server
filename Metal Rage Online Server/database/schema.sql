-- =============================================
-- Metal Rage Online - Database Schema
-- =============================================
-- Designed to match the game's protocol data structures
-- while staying simple and easy to work with in a SQL editor.
--
-- Tables map directly to protocol messages:
--   accounts      -> SN_DEFAULT_INFO (0x210101)
--   records       -> SN_RECORD_INFO (0x210103)
--   mech_levels   -> SN_MECH_LEVEL (0x210104)
--   mech_licenses -> SN_LICENSE_INFO (0x260101)
--   items         -> SN_ITEM_INFO (0x210111)
--   tutorials     -> Quest tracking (0x260111)
--   friends       -> Friend list (0x22XXXX social)
-- =============================================

CREATE DATABASE IF NOT EXISTS mro;
USE mro;

-- =============================================
-- ACCOUNTS - Core player identity
-- Sent in: SN_DEFAULT_INFO (0x210101), SA_LOGIN
-- =============================================
CREATE TABLE IF NOT EXISTS accounts (
    id              INT UNSIGNED    AUTO_INCREMENT PRIMARY KEY,
    username        VARCHAR(25)     NOT NULL UNIQUE,     -- Login username (from CQ_LOGIN_WASABII)
    nickname        VARCHAR(25)     NOT NULL UNIQUE,     -- In-game display name
    pilot           INT UNSIGNED    NOT NULL DEFAULT 101,-- Pilot avatar (101 or 102)
    account_level   TINYINT         NOT NULL DEFAULT 1,  -- 1=Spectator, 2=MC, 3=GM, 4=Dev
    gender          TINYINT         NOT NULL DEFAULT 1,  -- 1=Male, 2=Female
    created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_login      TIMESTAMP       NULL DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- =============================================
-- RECORDS - Player stats (win/loss/kill/death)
-- Sent in: SN_RECORD_INFO (0x210103)
-- =============================================
CREATE TABLE IF NOT EXISTS records (
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
-- Record size: 0x1c (28) bytes per mech
-- Max 8 mech types (Light, Assault, Medium, Sniper,
--   Firepower, Engineer, Maintenance, Observation)
-- =============================================
CREATE TABLE IF NOT EXISTS mech_levels (
    account_id      INT UNSIGNED    NOT NULL,
    mech_type       TINYINT         NOT NULL,  -- 1-8, matches MechType enum
    level           INT UNSIGNED    NOT NULL DEFAULT 1,
    exp             BIGINT UNSIGNED NOT NULL DEFAULT 0,
    kills           INT UNSIGNED    NOT NULL DEFAULT 0,
    deaths          INT UNSIGNED    NOT NULL DEFAULT 0,
    sorties         INT UNSIGNED    NOT NULL DEFAULT 0,  -- Times deployed

    PRIMARY KEY (account_id, mech_type),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- =============================================
-- MECH_LICENSES - Which mechs the player can use
-- Sent in: SN_LICENSE_INFO (0x260101)
-- 9 bytes per slot: mech_type (4B) + padding (1B) + license_type (4B)
-- =============================================
CREATE TABLE IF NOT EXISTS mech_licenses (
    account_id      INT UNSIGNED    NOT NULL,
    slot            TINYINT         NOT NULL,  -- 0-7, slot index
    mech_type       TINYINT         NOT NULL,  -- 1-8, matches MechType enum
    license_type    TINYINT         NOT NULL DEFAULT 0,  -- 0=none, 1=purchased, 2=tutorial

    PRIMARY KEY (account_id, slot),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- =============================================
-- ITEMS - Player inventory (weapons, parts, etc.)
-- Sent in: SN_ITEM_INFO (0x210111)
-- This covers mech parts, weapons, accessories
-- =============================================
CREATE TABLE IF NOT EXISTS items (
    id              INT UNSIGNED    AUTO_INCREMENT PRIMARY KEY,
    account_id      INT UNSIGNED    NOT NULL,
    item_id         INT UNSIGNED    NOT NULL,  -- Game's internal item ID
    slot            TINYINT         NOT NULL DEFAULT 0,  -- Equipment slot (0 = inventory)
    mech_type       TINYINT         NOT NULL DEFAULT 0,  -- Which mech it's equipped on (0 = none)
    part_slot       TINYINT         NOT NULL DEFAULT 0,  -- Part position on the mech (0-5)
    quantity        INT UNSIGNED    NOT NULL DEFAULT 1,
    equipped        TINYINT         NOT NULL DEFAULT 0,  -- 0=in inventory, 1=equipped

    INDEX idx_account (account_id),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- =============================================
-- TUTORIALS - Track which tutorials are completed
-- Related to: Quest dispatch (0x260111, 0x260121)
-- MAX_TUTORIAL_COUNT = 4
-- =============================================
CREATE TABLE IF NOT EXISTS tutorials (
    account_id      INT UNSIGNED    NOT NULL,
    tutorial_id     TINYINT         NOT NULL,  -- Tutorial index (1-4)
    completed       TINYINT         NOT NULL DEFAULT 0,
    completed_at    TIMESTAMP       NULL DEFAULT NULL,

    PRIMARY KEY (account_id, tutorial_id),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- =============================================
-- MAPS - Which maps the player has unlocked
-- Sent in: SN_MAP_INFO (0x210115)
-- MAX_MAP_COUNT = 6
-- =============================================
CREATE TABLE IF NOT EXISTS maps (
    account_id      INT UNSIGNED    NOT NULL,
    map_id          INT UNSIGNED    NOT NULL,  -- Map index

    PRIMARY KEY (account_id, map_id),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- =============================================
-- FRIENDS - Friend list
-- Related to: ZDispatchFriend (0x22XXXX social range)
-- =============================================
CREATE TABLE IF NOT EXISTS friends (
    account_id      INT UNSIGNED    NOT NULL,
    friend_id       INT UNSIGNED    NOT NULL,
    friend_type     TINYINT         NOT NULL DEFAULT 0,  -- 0=friend, 1=incoming, 2=outgoing

    PRIMARY KEY (account_id, friend_id),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    FOREIGN KEY (friend_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- =============================================
-- Default data insert for new accounts
-- Call this procedure after creating an account
-- to populate all the default data a new player needs.
-- =============================================
DELIMITER //
DROP PROCEDURE IF EXISTS create_new_player //
CREATE PROCEDURE create_new_player(
    IN p_username VARCHAR(25),
    IN p_nickname VARCHAR(25),
    IN p_pilot INT UNSIGNED
)
BEGIN
    DECLARE v_account_id INT UNSIGNED;

    -- Create the account
    INSERT INTO accounts (username, nickname, pilot)
    VALUES (p_username, p_nickname, p_pilot);

    SET v_account_id = LAST_INSERT_ID();

    -- Initialize player record (level 1, no stats)
    INSERT INTO records (account_id)
    VALUES (v_account_id);

    -- Initialize all 8 mech levels at level 1
    INSERT INTO mech_levels (account_id, mech_type) VALUES
        (v_account_id, 1), (v_account_id, 2), (v_account_id, 3), (v_account_id, 4),
        (v_account_id, 5), (v_account_id, 6), (v_account_id, 7), (v_account_id, 8);

    -- Give all 8 mech licenses (purchased) by default
    -- In a real server you'd start with fewer and unlock via tutorials
    INSERT INTO mech_licenses (account_id, slot, mech_type, license_type) VALUES
        (v_account_id, 0, 1, 1), (v_account_id, 1, 2, 1), (v_account_id, 2, 3, 1), (v_account_id, 3, 4, 1),
        (v_account_id, 4, 5, 1), (v_account_id, 5, 6, 1), (v_account_id, 6, 7, 1), (v_account_id, 7, 8, 1);

    -- Unlock all 6 maps by default
    INSERT INTO maps (account_id, map_id) VALUES
        (v_account_id, 0), (v_account_id, 1), (v_account_id, 2),
        (v_account_id, 3), (v_account_id, 4), (v_account_id, 5);

    -- Initialize tutorial tracking (all incomplete)
    INSERT INTO tutorials (account_id, tutorial_id) VALUES
        (v_account_id, 1), (v_account_id, 2), (v_account_id, 3), (v_account_id, 4);

END //
DELIMITER ;
