#!/usr/bin/env python3
"""
Metal Rage Online - Complete Item ID & Weapon Code Extractor
Extracts all weapon codes, item definitions, struct fields, and data from UE2 packages.
"""

import struct
import os
import sys
import io
import re
from collections import defaultdict, OrderedDict

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

UE2_MAGIC = 0x9E2A83C1
DECRYPTED_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'decrypted')


def read_compact_index(data, offset):
    """Read UE2 compact index (variable-length signed integer)."""
    result = 0
    sign = False
    b = data[offset]; offset += 1
    sign = bool(b & 0x80)
    has_next = bool(b & 0x40)
    result = b & 0x3F
    shift = 6
    while has_next:
        if offset >= len(data): break
        b = data[offset]; offset += 1
        has_next = bool(b & 0x80)
        result |= (b & 0x7F) << shift
        shift += 7
        if shift > 32: break
    if sign: result = -result
    return result, offset


def read_ue2_name_table(data):
    """Read name table - version-aware. UE2 v128+ has length-prefixed strings."""
    version = struct.unpack_from('<H', data, 0x04)[0]
    name_count = struct.unpack_from('<I', data, 0x0C)[0]
    name_offset = struct.unpack_from('<I', data, 0x10)[0]

    names = []
    offset = name_offset

    for i in range(name_count):
        if offset >= len(data):
            break

        # For UE2 versions with length-prefixed names
        # The name format appears to be: null-terminated string + u32 flags
        # But the first byte might be a length prefix
        end = data.index(b'\x00', offset)
        raw_name = data[offset:end]

        # Check if first byte is a length prefix
        if len(raw_name) > 0 and raw_name[0] == len(raw_name):
            # First byte IS the length - skip it
            name = raw_name[1:].decode('ascii', errors='replace')
        elif len(raw_name) > 0 and raw_name[0] < 32 and raw_name[0] != 0:
            # First byte is likely a length or control byte - skip it
            name = raw_name[1:].decode('ascii', errors='replace')
        else:
            name = raw_name.decode('ascii', errors='replace')

        offset = end + 1  # skip null terminator
        if offset + 4 <= len(data):
            flags = struct.unpack_from('<I', data, offset)[0]
            offset += 4
        else:
            flags = 0

        names.append((name, flags))

    return names


class UE2Package:
    def __init__(self, filepath):
        self.filepath = filepath
        self.filename = os.path.basename(filepath)
        with open(filepath, 'rb') as f:
            self.data = f.read()

        if struct.unpack_from('<I', self.data, 0)[0] != UE2_MAGIC:
            raise ValueError(f"Not a UE2 package: {filepath}")

        self.version = struct.unpack_from('<H', self.data, 0x04)[0]
        self.licensee = struct.unpack_from('<H', self.data, 0x06)[0]
        self.name_count = struct.unpack_from('<I', self.data, 0x0C)[0]
        self.name_offset = struct.unpack_from('<I', self.data, 0x10)[0]
        self.export_count = struct.unpack_from('<I', self.data, 0x14)[0]
        self.export_offset = struct.unpack_from('<I', self.data, 0x18)[0]
        self.import_count = struct.unpack_from('<I', self.data, 0x1C)[0]
        self.import_offset = struct.unpack_from('<I', self.data, 0x20)[0]

        self.name_entries = read_ue2_name_table(self.data)
        self.names = [n[0] for n in self.name_entries]
        self.imports = self._read_imports()
        self.exports = self._read_exports()

    def get_name(self, idx):
        if 0 <= idx < len(self.names):
            return self.names[idx]
        return f"?{idx}"

    def _read_imports(self):
        imports = []
        offset = self.import_offset
        for i in range(self.import_count):
            try:
                class_package, offset = read_compact_index(self.data, offset)
                class_name, offset = read_compact_index(self.data, offset)
                package_idx = struct.unpack_from('<i', self.data, offset)[0]; offset += 4
                object_name, offset = read_compact_index(self.data, offset)
                imports.append({
                    'class_package': self.get_name(class_package),
                    'class_name': self.get_name(class_name),
                    'object_name': self.get_name(object_name),
                })
            except:
                break
        return imports

    def _read_exports(self):
        exports = []
        offset = self.export_offset
        for i in range(self.export_count):
            try:
                class_index, offset = read_compact_index(self.data, offset)
                super_index, offset = read_compact_index(self.data, offset)
                group = struct.unpack_from('<i', self.data, offset)[0]; offset += 4
                object_name, offset = read_compact_index(self.data, offset)
                object_flags = struct.unpack_from('<I', self.data, offset)[0]; offset += 4
                serial_size, offset = read_compact_index(self.data, offset)
                serial_offset = 0
                if serial_size > 0:
                    serial_offset, offset = read_compact_index(self.data, offset)
                exports.append({
                    'index': i,
                    'class_index': class_index,
                    'super_index': super_index,
                    'group': group,
                    'name_idx': object_name,
                    'name': self.get_name(object_name),
                    'flags': object_flags,
                    'serial_size': serial_size,
                    'serial_offset': serial_offset,
                })
            except:
                break
        return exports

    def resolve_class(self, class_index):
        if class_index == 0: return "Class"
        if class_index < 0:
            idx = -class_index - 1
            if 0 <= idx < len(self.imports):
                return self.imports[idx]['object_name']
        else:
            idx = class_index - 1
            if 0 <= idx < len(self.exports):
                return self.exports[idx]['name']
        return f"?cls{class_index}"

    def get_serial_data(self, export):
        off = export['serial_offset']
        size = export['serial_size']
        if off > 0 and off + size <= len(self.data):
            return self.data[off:off+size]
        return b''


def search_twt_items(twt_path):
    """Parse a UTF-16LE .twt file for [Section] entries."""
    if not os.path.exists(twt_path):
        return OrderedDict()

    with open(twt_path, 'rb') as f:
        content = f.read()

    try:
        text = content.decode('utf-16-le', errors='replace')
    except:
        text = content.decode('utf-16', errors='replace')

    items = OrderedDict()
    current_section = None

    for line in text.split('\n'):
        line = line.strip()
        if line.startswith('//'):
            # Commented section - still capture
            line = line.lstrip('/')
            line = line.strip()

        m = re.match(r'^\[([A-Za-z0-9_]+)\]', line)
        if m:
            current_section = m.group(1)
            if current_section not in items:
                items[current_section] = {}
            continue

        if current_section and '=' in line:
            key, _, val = line.partition('=')
            key = key.strip()
            val = val.strip().strip('"')
            items[current_section][key] = val

    return items


# ============================================================
# Main
# ============================================================

print("=" * 80)
print("  METAL RAGE ONLINE - COMPLETE ITEM & WEAPON EXTRACTION")
print("=" * 80)

# ============================
# 1. ALL WEAPON CODES from ZWeapon.unr
# ============================
print("\n" + "=" * 80)
print("  1. ALL WEAPON CODES (from ZWeapon.unr name table)")
print("=" * 80)

pkg = UE2Package(os.path.join(DECRYPTED_DIR, 'ZWeapon.unr'))

# Weapon code pattern: 2-4 uppercase letters + _ + lowercase/uppercase letter + optional _G
wep_pattern = re.compile(r'^[A-Z]{2,4}_[a-zA-Z](_G)?$')
weapon_codes = []
for idx, name in enumerate(pkg.names):
    if wep_pattern.match(name):
        weapon_codes.append((idx, name))

prefix_groups = defaultdict(list)
for idx, code in weapon_codes:
    prefix = code.split('_')[0]
    prefix_groups[prefix].append(code)

print(f"\n  Total weapon codes: {len(weapon_codes)}")
print(f"  Unique weapon types: {len(prefix_groups)}")

for prefix in sorted(prefix_groups.keys()):
    variants = sorted(prefix_groups[prefix])
    print(f"    {prefix}: {', '.join(variants)}")

# ============================
# 2. WEAPON NAMES from .twt files
# ============================
print("\n\n" + "=" * 80)
print("  2. WEAPON NAMES (from ZWeapon.twt)")
print("=" * 80)

twt_path = "D:/Jared/Downloads/Metal Rage Online Server/Client Files/Game Client/data/System/ZWeapon.twt"
twt_items = search_twt_items(twt_path)
print(f"\n  Found {len(twt_items)} weapon entries:")
for section, props in twt_items.items():
    name = props.get('ItemName', '')
    hint = props.get('HintMessage', '')
    target = props.get('TargetMessage', '')
    building = props.get('BuildingFinish', '')
    desc_parts = []
    if name: desc_parts.append(f"Name: {name}")
    if hint: desc_parts.append(f"Hint: {hint[:60]}")
    print(f"    [{section}] {' | '.join(desc_parts)}")

# ============================
# 3. WEAPON TYPE CATEGORIES from ZDefineWeapon.unr
# ============================
print("\n\n" + "=" * 80)
print("  3. WEAPON TYPE DEFINITIONS (ZDefineWeapon.unr)")
print("=" * 80)

pkg_def = UE2Package(os.path.join(DECRYPTED_DIR, 'ZDefineWeapon.unr'))

# Categories from the name table
main_weapons = []
assist_weapons = []
booster_weapons = []
observer_weapons = []
damage_types = []

for idx, name in enumerate(pkg_def.names):
    if name.startswith('Main_'):
        main_weapons.append(name)
    elif name.startswith('Assist_'):
        assist_weapons.append(name)
    elif name.startswith('Booster_'):
        booster_weapons.append(name)
    elif name.startswith('Observer_'):
        observer_weapons.append(name)
    elif name.startswith('DMain_') or name.startswith('DAssist_'):
        damage_types.append(name)

print(f"\n  Main Weapon Types ({len(main_weapons)}):")
for w in main_weapons:
    print(f"    {w}")

print(f"\n  Assist Weapon Types ({len(assist_weapons)}):")
for w in assist_weapons:
    print(f"    {w}")

print(f"\n  Booster Types ({len(booster_weapons)}):")
for w in booster_weapons:
    print(f"    {w}")

print(f"\n  Observer Types ({len(observer_weapons)}):")
for w in observer_weapons:
    print(f"    {w}")

# ============================
# 4. Item Data Structures from ZGameMainMenu.unr
# ============================
print("\n\n" + "=" * 80)
print("  4. ITEM DATA STRUCTURE FIELDS (ZGameMainMenu.unr)")
print("=" * 80)

pkg_menu = UE2Package(os.path.join(DECRYPTED_DIR, 'ZGameMainMenu.unr'))

# Find struct-related names
struct_fields = []
struct_names = set()
for idx, name in enumerate(pkg_menu.names):
    if name in ['GAME_ITEM_INFO', 'SHOP_ITEM_INFO', 'ITEM_SECTION', 'ITEM_DETAIL_INFO',
                'ITEM_SIMPLE_INFO', 'INVEN_ITEM_INFO', 'SELECT_ITEM_INFO', 'SELL_ITEM_INFO',
                'REWARD_ITEM_RECORD', 'NONEITEM', 'PROCESS_BUY', 'SHOP',
                'nItemCode', 'nItemIndex', 'ItemIndex', 'ItemHighGroup', 'ItemMiddleGroup',
                'ItemUseType', 'ItemRepresentIndex', 'ItemType', 'ItemSection',
                'StartItemNumber', 'EndItemNumber', 'GameItemList', 'GameItemRecord',
                'GameItemInfo', 'ShopList', 'CashShopList', 'SellPrice', 'Price',
                'DisplayPrice', 'WeaponMainRecord', 'WeaponSubRecord', 'WeaponMainData',
                'WeaponSubData', 'EquipmentData', 'RepresentIndex', 'nRepresentIndex',
                'MergeSerialIndex', 'nSoundIndex', 'ItemName', 'ItemDesc',
                'MAX_ITEM_SLOT', 'MAX_MECH_ITEM', 'MAX_ITEM_COUNT', 'MAX_ITEM_VIEW_COUNT',
                'mShop', 'mGameItemData', 'PartIndex', 'FunctionIndex', 'GroupIndex',
                'TypeIndex', 'WeaponMain', 'WeaponSubLeft', 'WeaponSubRight',
                'Grade', 'DefItemIndex']:
        struct_fields.append((idx, name))
        struct_names.add(name)

print(f"\n  Key item struct/field names in name table:")
for idx, name in sorted(struct_fields, key=lambda x: x[1]):
    print(f"    [{idx:4d}] {name}")

# ============================
# 5. GAME_ITEM_INFO from ZBase.unr
# ============================
print("\n\n" + "=" * 80)
print("  5. GAME_ITEM_INFO AND RELATED (ZBase.unr)")
print("=" * 80)

pkg_base = UE2Package(os.path.join(DECRYPTED_DIR, 'ZBase.unr'))

# Find GAME_ITEM_INFO struct and its fields
game_item_names = []
for idx, name in enumerate(pkg_base.names):
    if name in ['GAME_ITEM_INFO', 'ItemInfo', 'ItemList', 'ItemName', 'Item',
                'ItemType', 'ItemSection', 'ItemIndex', 'nItemIndex', 'nItemCode',
                'ItemHighGroup', 'ItemMiddleGroup', 'ItemRepresentIndex',
                'RepresentIndex', 'WeaponMainRecord', 'WeaponSubRecord',
                'SpecWeaponMainRecord', 'SpecWeaponSubRecord',
                'GameItemRecord', 'GameItemList', 'GameItemInfo',
                'GetItemMiddleGroup', 'GetRepresentIndex',
                'GetSpecWeaponMainRecord', 'GetSpecWeaponSubRecord',
                'Game_ItemList_Get', 'GetItemName',
                'e_MechSection', 'MechSection',
                'WeaponMain', 'WeaponSubLeft', 'WeaponSubRight',
                'Grade', 'GradeID', 'GradeSex']:
        game_item_names.append((idx, name))

print(f"\n  GAME_ITEM_INFO related names in ZBase.unr:")
for idx, name in game_item_names:
    print(f"    [{idx:4d}] {name}")

# Find the GAME_ITEM_INFO struct export and its field exports
print(f"\n  GAME_ITEM_INFO struct exports:")
for exp in pkg_base.exports:
    cls = pkg_base.resolve_class(exp['class_index'])
    if exp['name'] == 'GAME_ITEM_INFO' or (cls == 'ScriptStruct' and 'ITEM' in exp['name'].upper()):
        print(f"    [{exp['index']}] {exp['name']} (class: {cls}, size: {exp['serial_size']})")

# Find all ScriptStruct and Struct exports
print(f"\n  All struct-type exports related to items/weapons:")
for exp in pkg_base.exports:
    cls = pkg_base.resolve_class(exp['class_index'])
    name = exp['name']
    if cls in ['ScriptStruct', 'Struct'] or name in game_item_names:
        if any(kw in name.lower() for kw in ['item', 'weapon', 'shop', 'game', 'record', 'section']):
            print(f"    [{exp['index']}] {name} (class: {cls}, size: {exp['serial_size']})")

# ============================
# 6. COMPLETE WEAPON CODE MAP
# ============================
print("\n\n" + "=" * 80)
print("  6. COMPLETE WEAPON CODE MAP (Code -> Name -> Category)")
print("=" * 80)

# Weapon type categories from ZDefineWeapon
weapon_type_map = {
    'Main_Numbers_Vulcan': 'Vulcan (Multi-barrel)',
    'Main_Flame_Fire': 'Flamethrower',
    'Main_One_Rocket': 'Single Rocket',
    'Main_Numbers_Rocket': 'Multi Rocket',
    'Main_One_Cannon': 'Single Cannon',
    'Main_Numbers_Cannon': 'Multi Cannon',
    'Main_Multi_Cannon': 'Multi Cannon',
    'Main_Sniper_Cannon': 'Sniper',
    'Main_Long_Howitzer': 'Long-range Howitzer',
    'Main_Long_Defence': 'Long-range Defense',
    'Main_Throw_Explosion': 'Grenade',
    'Main_AI_Turret': 'AI Turret',
    'Main_Laser_Turret': 'Laser Turret',
    'Main_Missile_Turret': 'Missile Turret',
    'Main_Hit_Arm': 'Melee Arm',
    'Main_Saw_Arm': 'Saw Arm',
    'Main_Probe_Fire': 'Probe',
    'Main_Range_Cannon': 'Range Cannon',
    'Main_Sniper_Gathercannon': 'Sniper Gather',
    'Main_Napalm_Howitzer': 'Napalm Howitzer',
    'Main_Auto_Machinegun': 'Auto Machinegun',
    'Main_One_Laser': 'Laser',
    'Main_One_Vulcan': 'Vulcan (Single)',
    'Main_One_Shotgun': 'Shotgun',
    'Main_One_Machinegun': 'Machinegun',
    'Main_Bombing_Specify': 'Bombing',
    'Main_Target_Specify': 'Target Lock',
    'Main_One_Airgun': 'Air Gun',
    'Assist_Building_Arm': 'Construction',
    'Assist_Doctor_Arm': 'Repair',
    'Assist_Trap_Arm': 'Trap',
    'Assist_One_Machinegun': 'Assist Machinegun',
    'Assist_One_Cannon': 'Assist Cannon',
    'Assist_Close_Howitzer': 'Close Howitzer',
    'Assist_One_Rocket': 'Assist Rocket',
    'Assist_Numbers_Rocket': 'Assist Multi Rocket',
    'Assist_Multiple_Rocket': 'Multiple Rocket',
    'Assist_One_Guiderocket': 'Guided Rocket',
    'Assist_Numbers_Guiderocket': 'Multi Guided Rocket',
    'Assist_Follow_Mine': 'Tracking Mine',
    'Assist_Electromagnetic_Fire': 'EMP',
    'Assist_Invisible_Fire': 'Invisible',
    'Assist_Jewel_Fire': 'Flare',
    'Assist_Glint_Fire': 'Flash',
    'Assist_Target_Rocket': 'Target Rocket',
    'Assist_Rise_Mine': 'Rising Mine',
    'Assist_Neutral_Fire': 'Neutral Fire',
    'Booster_Plasma_Engine': 'Plasma',
    'Booster_Hydrogen_Engine': 'Hydrogen',
    'Booster_Nano_Engine': 'Nano',
    'Observer_Target_Specify': 'Observer Target',
}

# Map weapon codes to names from .twt
print(f"\n  {'Code':<12} {'Name':<35} {'Category'}")
print(f"  {'-'*12} {'-'*35} {'-'*30}")

# Get all unique weapon type prefixes
all_prefixes = sorted(prefix_groups.keys())

for prefix in all_prefixes:
    variants = sorted(prefix_groups[prefix])
    base_variant = variants[0]
    twt_name = twt_items.get(base_variant, {}).get('ItemName', '')
    if not twt_name:
        # Try with just the prefix
        for v in variants:
            if v in twt_items:
                twt_name = twt_items[v].get('ItemName', '')
                break

    for variant in variants:
        vname = twt_items.get(variant, {}).get('ItemName', twt_name)
        print(f"  {variant:<12} {vname:<35}")

# ============================
# 7. Mech types
# ============================
print("\n\n" + "=" * 80)
print("  7. MECH TYPES")
print("=" * 80)

# From ZBase.twt, find mech section info
base_twt_path = "D:/Jared/Downloads/Metal Rage Online Server/Client Files/Game Client/data/System/ZBase.twt"
base_twt = search_twt_items(base_twt_path)

print(f"\n  ZBase.twt sections: {list(base_twt.keys())[:20]}")

# From protocol/SQL: 8 mech types
print("""
  From server code (mech_type 1-8):
    1: Light
    2: Assault
    3: Medium
    4: Sniper
    5: Firepower
    6: Engineer
    7: Maintenance
    8: Observation
""")

# ============================
# 8. Scan ALL decrypted packages for item keywords
# ============================
print("\n" + "=" * 80)
print("  8. SCANNING ALL PACKAGES FOR ITEM-RELATED NAMES")
print("=" * 80)

keywords = ['item', 'shop', 'reward', 'price', 'equip']

for fname in sorted(os.listdir(DECRYPTED_DIR)):
    if not fname.endswith('.unr'):
        continue
    fpath = os.path.join(DECRYPTED_DIR, fname)
    try:
        p = UE2Package(fpath)
    except:
        continue

    matches = []
    for idx, name in enumerate(p.names):
        nl = name.lower()
        for kw in keywords:
            if kw in nl:
                matches.append((idx, name, kw))
                break

    if matches:
        print(f"\n  {fname} ({len(matches)} matches):")
        for idx, name, kw in matches[:15]:
            print(f"    [{idx:4d}] {name}  (matched: {kw})")
        if len(matches) > 15:
            print(f"    ... and {len(matches)-15} more")

# ============================
# 9. ZBaseMechanic.twt - weapon per mech type
# ============================
print("\n\n" + "=" * 80)
print("  9. MECH WEAPON ASSIGNMENTS (ZBaseMechanic.twt)")
print("=" * 80)

mech_twt_path = "D:/Jared/Downloads/Metal Rage Online Server/Client Files/Game Client/data/System/ZBaseMechanic.twt"
mech_items = search_twt_items(mech_twt_path)
if mech_items:
    for section, props in mech_items.items():
        print(f"\n  [{section}]")
        for k, v in props.items():
            print(f"    {k} = {v[:100]}")
else:
    print("  (No ZBaseMechanic.twt found)")

# ============================
# 10. Try ZBase.c_twt for Korean original names
# ============================
print("\n\n" + "=" * 80)
print("  10. ZWeapon.c_twt (Korean original weapon data)")
print("=" * 80)

ctwt_path = "D:/Jared/Downloads/Metal Rage Online Server/Client Files/Game Client/data/System/ZWeapon.c_twt"
if os.path.exists(ctwt_path):
    with open(ctwt_path, 'rb') as f:
        content = f.read()
    try:
        text = content.decode('utf-16-le', errors='replace')
    except:
        text = content.decode('utf-16', errors='replace')

    # Just show sections
    current_section = None
    for line in text.split('\n'):
        line = line.strip()
        m = re.match(r'^\[([A-Za-z0-9_]+)\]', line)
        if m:
            current_section = m.group(1)
            print(f"  [{current_section}]")
            continue
        if current_section and 'ItemName' in line:
            print(f"    {line[:100]}")

print("\n\nExtraction complete.")
