const MAX_ROOM_NAME_COUNT = 5;
const MAX_MECH_COUNT = 8;
const MAX_SLOT_COUNT = 8;
const MAX_PART_COUNT = 6;
const MAX_MAP_COUNT = 6;
const MAX_EMBLEM_COUNT = 2;
const MAX_CARD_REWARD_COUNT = 5;
const MAX_CARD_EXCHANGE_COUNT = 6;
const MAX_CARD_COMBINATION_COUNT = 5;
const MAX_TUTORIAL_COUNT = 4;
const MAX_SOCKET_COUNT = 3;


module.exports =
{
    MAX_ROOM_NAME_COUNT,
    MAX_MECH_COUNT,
    MAX_SLOT_COUNT,
    MAX_PART_COUNT,
    MAX_MAP_COUNT,
    MAX_EMBLEM_COUNT,
    MAX_CARD_REWARD_COUNT,
    MAX_CARD_EXCHANGE_COUNT,
    MAX_CARD_COMBINATION_COUNT,
    MAX_TUTORIAL_COUNT,
    MAX_SOCKET_COUNT,

    PublisherType:
    {
        GameHi: 0,
        NetMarble: 1,
        GameYarou: 2,
        Wasabii: 3,
        NexonJapan: 4
    },

    CertifyType:
    {
        None: 0,
        Account: 1,
        Member: 2,
        Web: 3,
        Away: 4
    },

    MechType:
    {
        Light: 1,
        Assault: 2,
        Medium: 3,
        Sniper: 4,
        Firepower: 5,
        Engineer: 6,
        Maintenance: 7,
        Observation: 8
    },

    UserType:
    {
        Male: 1,
        Female: 2
    },

    ServerState:
    {
        Unconfirmed: 1,
        Connected: 2,
        Connectable: 3,
        Maintenance: 4
    },

    ChannelType:
    {
        General: 0,
        Clan: 1,
        Competition: 2
    },

    RoomType:
    {
        Normal: 0,
        ClanWar: 1,
        Campaign: 2,
        QuickMatching: 3
    },

    ChatType:
    {
        System: 0,
        All: 1,
        Team: 2,
        Whisper: 3,
        Clan: 4,
        ClanManager: 5,
        ServerNotice: 6,
        Warning: 7
    },

    FriendType:
    {
        Friend: 0,
        IncomingFriendRequest: 1,
        OutgoingFriendRequest: 2
    },

    PostType:
    {
        Announcement: 0,
        General: 1,
        Clan: 2,
        Event: 3,
        Gift: 4
    },

    RewardType:
    {
        Item: 0,
        Point: 1,
        Coupon: 2
    },

    SceneType:
    {
        Server: 0, // Waiting for server connection
        Wait: 1, // Waiting (Only on dedicated servers)
        Account: 2, // Login
        Gate: 3, // Gate
        Lobby: 4, // Lobby
        Room: 5, // Waiting room
        Game: 6 // Game (Used on both client and dedicated)
    }
};
