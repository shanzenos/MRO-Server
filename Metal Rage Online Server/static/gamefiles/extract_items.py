#!/usr/bin/env python3
"""
Metal Rage Online - UE2 Package Item ID Extractor
Parses decrypted .unr (Unreal Engine 2) packages to find item definitions.

UE2 Package Format:
  Header -> Name Table -> Export Table -> Import Table -> Object Data
"""

import struct
import os
import sys
import re
import io
from collections import defaultdict

# Force UTF-8 output on Windows
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

# ============================================================
# UE2 Package Header
# ============================================================
UE2_MAGIC = 0x9E2A83C1

def read_compact_index(data, offset):
    """Read UE2 compact index (variable-length signed integer).

    UE2 uses a compact index encoding:
    - Byte 0: bit 0 = sign, bits 1-5 = value, bit 6 = more, bit 7 = more2
    - Byte 1+: bits 0-6 = value continuation, bit 7 = more
    """
    result = 0
    sign = False

    b = data[offset]
    offset += 1

    sign = bool(b & 0x80)
    has_next = bool(b & 0x40)
    result = b & 0x3F

    shift = 6
    while has_next:
        b = data[offset]
        offset += 1
        has_next = bool(b & 0x80)
        result |= (b & 0x7F) << shift
        shift += 7
        if shift > 32:
            break

    if sign:
        result = -result

    return result, offset


class UE2Package:
    def __init__(self, filepath):
        self.filepath = filepath
        self.filename = os.path.basename(filepath)
        self.data = None
        self.version = 0
        self.licensee = 0
        self.flags = 0
        self.name_count = 0
        self.name_offset = 0
        self.export_count = 0
        self.export_offset = 0
        self.import_count = 0
        self.import_offset = 0
        self.names = []
        self.exports = []
        self.imports = []

    def load(self):
        with open(self.filepath, 'rb') as f:
            self.data = f.read()
        return self._parse_header()

    def _parse_header(self):
        if len(self.data) < 0x24:
            return False

        magic = struct.unpack_from('<I', self.data, 0x00)[0]
        if magic != UE2_MAGIC:
            return False

        self.version = struct.unpack_from('<H', self.data, 0x04)[0]
        self.licensee = struct.unpack_from('<H', self.data, 0x06)[0]
        self.flags = struct.unpack_from('<I', self.data, 0x08)[0]
        self.name_count = struct.unpack_from('<I', self.data, 0x0C)[0]
        self.name_offset = struct.unpack_from('<I', self.data, 0x10)[0]
        self.export_count = struct.unpack_from('<I', self.data, 0x14)[0]
        self.export_offset = struct.unpack_from('<I', self.data, 0x18)[0]
        self.import_count = struct.unpack_from('<I', self.data, 0x1C)[0]
        self.import_offset = struct.unpack_from('<I', self.data, 0x20)[0]

        return True

    def read_names(self):
        """Read all entries from the name table."""
        offset = self.name_offset
        self.names = []

        for i in range(self.name_count):
            if offset >= len(self.data):
                break

            # Find null terminator for the name string
            end = self.data.index(b'\x00', offset)
            name = self.data[offset:end].decode('ascii', errors='replace')
            offset = end + 1

            # Skip flags (4 bytes)
            if offset + 4 <= len(self.data):
                flags = struct.unpack_from('<I', self.data, offset)[0]
                offset += 4
            else:
                flags = 0

            self.names.append((name, flags))

        return self.names

    def get_name(self, index):
        """Get name by index, safely."""
        if 0 <= index < len(self.names):
            return self.names[index][0]
        return f"<invalid_{index}>"

    def read_imports(self):
        """Read all entries from the import table."""
        offset = self.import_offset
        self.imports = []

        for i in range(self.import_count):
            if offset + 20 > len(self.data):
                break

            try:
                class_package, offset = read_compact_index(self.data, offset)
                class_name, offset = read_compact_index(self.data, offset)
                package_idx = struct.unpack_from('<i', self.data, offset)[0]
                offset += 4
                object_name, offset = read_compact_index(self.data, offset)

                self.imports.append({
                    'class_package': class_package,
                    'class_name': class_name,
                    'package': package_idx,
                    'object_name': object_name,
                    'class_package_str': self.get_name(class_package),
                    'class_name_str': self.get_name(class_name),
                    'object_name_str': self.get_name(object_name),
                })
            except Exception as e:
                break

        return self.imports

    def read_exports(self):
        """Read all entries from the export table."""
        offset = self.export_offset
        self.exports = []

        for i in range(self.export_count):
            if offset >= len(self.data):
                break

            try:
                start_offset = offset
                class_index, offset = read_compact_index(self.data, offset)
                super_index, offset = read_compact_index(self.data, offset)
                group = struct.unpack_from('<i', self.data, offset)[0]
                offset += 4
                object_name, offset = read_compact_index(self.data, offset)
                object_flags = struct.unpack_from('<I', self.data, offset)[0]
                offset += 4
                serial_size, offset = read_compact_index(self.data, offset)

                serial_offset = 0
                if serial_size > 0:
                    serial_offset, offset = read_compact_index(self.data, offset)

                self.exports.append({
                    'index': i,
                    'class_index': class_index,
                    'super_index': super_index,
                    'group': group,
                    'object_name': object_name,
                    'object_flags': object_flags,
                    'serial_size': serial_size,
                    'serial_offset': serial_offset,
                    'object_name_str': self.get_name(object_name),
                })
            except Exception as e:
                break

        return self.exports

    def resolve_class_name(self, class_index):
        """Resolve a class index to a name string.
        Positive = export table index (+1 based)
        Negative = import table index (-1 based)
        Zero = Class itself
        """
        if class_index == 0:
            return "Class"
        elif class_index < 0:
            imp_idx = -class_index - 1
            if 0 <= imp_idx < len(self.imports):
                return self.imports[imp_idx]['object_name_str']
        else:
            exp_idx = class_index - 1
            if 0 <= exp_idx < len(self.exports):
                return self.exports[exp_idx]['object_name_str']
        return f"<unresolved_{class_index}>"

    def read_export_properties(self, export_entry, max_props=50):
        """Try to read UE2 property data from an export's serial data."""
        props = []
        offset = export_entry['serial_offset']
        end_offset = offset + export_entry['serial_size']

        if offset <= 0 or offset >= len(self.data) or end_offset > len(self.data):
            return props

        # For UObjects, first read any state frame / class header depending on type
        # We'll try to skip to property list

        tries = 0
        while offset < end_offset and tries < max_props:
            tries += 1
            try:
                # Read property name (compact index into name table)
                name_idx, new_offset = read_compact_index(self.data, offset)

                if name_idx < 0 or name_idx >= len(self.names):
                    break

                prop_name = self.names[name_idx][0]

                # "None" marks end of properties
                if prop_name == "None":
                    break

                offset = new_offset

                # Read property info byte
                if offset >= end_offset:
                    break
                info_byte = self.data[offset]
                offset += 1

                prop_type = info_byte & 0x0F
                size_type = (info_byte >> 4) & 0x07
                is_array = bool(info_byte & 0x80)

                # Determine property size
                if size_type == 0:
                    prop_size = 1
                elif size_type == 1:
                    prop_size = 2
                elif size_type == 2:
                    prop_size = 4
                elif size_type == 3:
                    prop_size = 12
                elif size_type == 4:
                    prop_size = 16
                elif size_type == 5:
                    if offset >= end_offset:
                        break
                    prop_size = self.data[offset]
                    offset += 1
                elif size_type == 6:
                    if offset + 2 > end_offset:
                        break
                    prop_size = struct.unpack_from('<H', self.data, offset)[0]
                    offset += 2
                elif size_type == 7:
                    if offset + 4 > end_offset:
                        break
                    prop_size = struct.unpack_from('<I', self.data, offset)[0]
                    offset += 4
                else:
                    break

                # Handle struct type name
                struct_name = None
                if prop_type == 10:  # StructProperty
                    struct_name_idx, offset = read_compact_index(self.data, offset)
                    if 0 <= struct_name_idx < len(self.names):
                        struct_name = self.names[struct_name_idx][0]

                # Handle array index
                array_index = 0
                if is_array:
                    if offset >= end_offset:
                        break
                    # Array index encoding
                    b = self.data[offset]
                    if b < 128:
                        array_index = b
                        offset += 1
                    else:
                        # Multi-byte array index
                        if offset + 1 < end_offset:
                            idx_low = b & 0x7F
                            idx_high = self.data[offset + 1]
                            array_index = idx_low | (idx_high << 7)
                            offset += 2
                        else:
                            offset += 1

                # Read property value
                if offset + prop_size > end_offset:
                    prop_value_raw = self.data[offset:end_offset]
                    offset = end_offset
                else:
                    prop_value_raw = self.data[offset:offset + prop_size]
                    offset += prop_size

                # Decode value based on type
                prop_value = None
                type_names = {
                    0: 'None', 1: 'Byte', 2: 'Int', 3: 'Bool',
                    4: 'Float', 5: 'Object', 6: 'Name', 7: 'Delegate',
                    8: 'Class', 9: 'Array', 10: 'Struct', 11: 'Vector',
                    12: 'Rotator', 13: 'Str', 14: 'Map', 15: 'FixedArray'
                }

                if prop_type == 1 and len(prop_value_raw) >= 1:  # Byte
                    prop_value = prop_value_raw[0]
                elif prop_type == 2 and len(prop_value_raw) >= 4:  # Int
                    prop_value = struct.unpack_from('<i', prop_value_raw)[0]
                elif prop_type == 3:  # Bool
                    prop_value = True  # Bool value is in the info byte itself
                elif prop_type == 4 and len(prop_value_raw) >= 4:  # Float
                    prop_value = struct.unpack_from('<f', prop_value_raw)[0]
                elif prop_type == 5 and len(prop_value_raw) >= 4:  # Object ref
                    prop_value = struct.unpack_from('<i', prop_value_raw)[0]
                elif prop_type == 6 and len(prop_value_raw) >= 4:  # Name
                    name_val, _ = read_compact_index(prop_value_raw, 0)
                    if 0 <= name_val < len(self.names):
                        prop_value = self.names[name_val][0]
                    else:
                        prop_value = f"Name#{name_val}"
                elif prop_type == 13:  # String
                    try:
                        # UE2 strings: compact_index length + chars
                        str_len, soff = read_compact_index(prop_value_raw, 0)
                        if str_len > 0 and soff + str_len <= len(prop_value_raw):
                            prop_value = prop_value_raw[soff:soff+str_len].decode('ascii', errors='replace').rstrip('\x00')
                        else:
                            prop_value = prop_value_raw.decode('ascii', errors='replace').rstrip('\x00')
                    except:
                        prop_value = repr(prop_value_raw[:64])
                else:
                    # For unknown types, show hex if small
                    if len(prop_value_raw) <= 16:
                        prop_value = prop_value_raw.hex()
                    else:
                        prop_value = f"<{len(prop_value_raw)} bytes>"

                props.append({
                    'name': prop_name,
                    'type': type_names.get(prop_type, f'type{prop_type}'),
                    'size': prop_size,
                    'value': prop_value,
                    'array_index': array_index,
                    'struct_name': struct_name,
                    'raw': prop_value_raw,
                })

            except Exception as e:
                break

        return props


def analyze_package(filepath, verbose=False):
    """Analyze a single UE2 package for item data."""
    pkg = UE2Package(filepath)

    if not pkg.load():
        print(f"  [SKIP] Not a valid UE2 package: {filepath}")
        return None

    pkg.read_names()
    pkg.read_imports()
    pkg.read_exports()

    result = {
        'file': pkg.filename,
        'version': pkg.version,
        'licensee': pkg.licensee,
        'name_count': pkg.name_count,
        'export_count': pkg.export_count,
        'import_count': pkg.import_count,
        'names': pkg.names,
        'exports': pkg.exports,
        'imports': pkg.imports,
        'item_names': [],
        'export_details': [],
    }

    # Filter for item-related names
    item_patterns = [
        r'^[A-Z]{2,4}_[a-z]$',         # Weapon codes like ABA_a, MSC_a, MOM_b
        r'Item',
        r'Shop',
        r'Weapon',
        r'Equip',
        r'Price',
        r'Cost',
        r'Reward',
        r'tutorial',
        r'Card',
        r'Part',
        r'Mech',
        r'License',
        r'Slot',
        r'Category',
        r'Grade',
        r'Index',
        r'Type',
        r'Count',
        r'Level',
        r'nID',
        r'ID$',
    ]

    combined_pattern = '|'.join(f'(?:{p})' for p in item_patterns)

    for idx, (name, flags) in enumerate(pkg.names):
        if re.search(combined_pattern, name, re.IGNORECASE):
            result['item_names'].append((idx, name, flags))

    # Analyze exports
    for exp in pkg.exports:
        class_name = pkg.resolve_class_name(exp['class_index'])
        obj_name = exp['object_name_str']

        # Try to read properties for interesting objects
        props = []
        if exp['serial_size'] > 0 and exp['serial_size'] < 100000:
            props = pkg.read_export_properties(exp)

        detail = {
            'index': exp['index'],
            'name': obj_name,
            'class': class_name,
            'size': exp['serial_size'],
            'offset': exp['serial_offset'],
            'properties': props,
        }
        result['export_details'].append(detail)

    return result


def print_results(result, show_all_names=False, show_all_exports=False):
    """Print analysis results."""
    print(f"\n{'='*80}")
    print(f"  Package: {result['file']}")
    print(f"  Version: {result['version']}, Licensee: {result['licensee']}")
    print(f"  Names: {result['name_count']}, Exports: {result['export_count']}, Imports: {result['import_count']}")
    print(f"{'='*80}")

    # Print ALL names for priority files
    if show_all_names:
        print(f"\n  --- ALL NAMES ({len(result['names'])}) ---")
        for idx, (name, flags) in enumerate(result['names']):
            flag_str = f"  (flags: 0x{flags:08X})" if flags else ""
            print(f"    [{idx:4d}] {name}{flag_str}")
    else:
        # Print item-related names
        if result['item_names']:
            print(f"\n  --- ITEM-RELATED NAMES ({len(result['item_names'])}) ---")
            for idx, name, flags in result['item_names']:
                flag_str = f"  (flags: 0x{flags:08X})" if flags else ""
                print(f"    [{idx:4d}] {name}{flag_str}")

    # Print exports with their properties
    if show_all_exports:
        print(f"\n  --- ALL EXPORTS ({len(result['export_details'])}) ---")
        for detail in result['export_details']:
            print(f"\n    Export[{detail['index']}]: {detail['name']} (class: {detail['class']}, size: {detail['size']}, offset: 0x{detail['offset']:X})")
            if detail['properties']:
                for prop in detail['properties']:
                    arr_str = f"[{prop['array_index']}]" if prop['array_index'] > 0 else ""
                    struct_str = f" ({prop['struct_name']})" if prop['struct_name'] else ""
                    print(f"      {prop['name']}{arr_str}: {prop['type']}{struct_str} = {prop['value']}")
    else:
        # Only show exports that have properties
        exports_with_props = [d for d in result['export_details'] if d['properties']]
        if exports_with_props:
            print(f"\n  --- EXPORTS WITH PROPERTIES ({len(exports_with_props)}) ---")
            for detail in exports_with_props:
                print(f"\n    Export[{detail['index']}]: {detail['name']} (class: {detail['class']}, size: {detail['size']})")
                for prop in detail['properties']:
                    arr_str = f"[{prop['array_index']}]" if prop['array_index'] > 0 else ""
                    struct_str = f" ({prop['struct_name']})" if prop['struct_name'] else ""
                    print(f"      {prop['name']}{arr_str}: {prop['type']}{struct_str} = {prop['value']}")


def search_raw_for_patterns(filepath):
    """Search raw binary for recognizable item-related patterns."""
    with open(filepath, 'rb') as f:
        data = f.read()

    results = []

    # Search for weapon code patterns in raw data (3-letter codes like ABA, MSC, etc.)
    known_codes = [
        'ABA', 'ACH', 'ADA', 'AEF', 'AFM', 'AIF', 'AMR', 'ANF', 'ANG', 'ANR',
        'AOC', 'AOG', 'AOM', 'AOR', 'ARM', 'ATA', 'ATR',
        'BHE', 'BNE', 'BPE',
        'ICT', 'IGT', 'ILM', 'ILT', 'IMT', 'IRM',
        'MAM', 'MAT', 'MBS', 'MFF', 'MHA', 'MLD', 'MLH', 'MMC', 'MNC', 'MNH',
        'MNR', 'MNV', 'MOC', 'MOL', 'MOM', 'MOR', 'MOS', 'MOV', 'MPF', 'MRC',
        'MSA', 'MSC', 'MSG', 'MTE', 'MTS',
        'OTS', 'AMM',
    ]

    # Look for these codes with suffixes like _a, _b, _c, _I, _J
    for code in known_codes:
        for suffix in ['_a', '_b', '_c', '_d', '_e', '_I', '_J']:
            pattern = (code + suffix).encode('ascii')
            idx = 0
            while True:
                idx = data.find(pattern, idx)
                if idx == -1:
                    break
                # Check if it looks like a proper string boundary
                # (preceded by length or null, followed by null or underscore)
                context_start = max(0, idx - 8)
                context_end = min(len(data), idx + len(pattern) + 8)
                context = data[context_start:context_end]
                results.append((idx, code + suffix, context.hex()))
                idx += 1

    return results


def scan_all_names_for_keywords(decrypted_dir, keywords):
    """Scan all .unr files for names matching keywords."""
    matches = defaultdict(list)

    for fname in sorted(os.listdir(decrypted_dir)):
        if not fname.endswith('.unr'):
            continue

        filepath = os.path.join(decrypted_dir, fname)
        pkg = UE2Package(filepath)

        if not pkg.load():
            continue

        pkg.read_names()

        for idx, (name, flags) in enumerate(pkg.names):
            name_lower = name.lower()
            for kw in keywords:
                if kw.lower() in name_lower:
                    matches[fname].append((idx, name, kw))
                    break

    return matches


# ============================================================
# Main
# ============================================================
if __name__ == '__main__':
    DECRYPTED_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'decrypted')

    if not os.path.isdir(DECRYPTED_DIR):
        print(f"ERROR: Decrypted directory not found: {DECRYPTED_DIR}")
        sys.exit(1)

    # ============================
    # Phase 1: Priority files - full analysis
    # ============================
    priority_files = [
        'ZShopItem.unr',
        'ZPopupItems.unr',
        'ZCardItem.unr',
        'ZHangarShop.unr',
        'ZDefineWeapon.unr',
        'ZBaseWeapon.unr',
        'ZWeapon.unr',
    ]

    print("=" * 80)
    print("  PHASE 1: PRIORITY FILE ANALYSIS")
    print("=" * 80)

    for fname in priority_files:
        fpath = os.path.join(DECRYPTED_DIR, fname)
        if not os.path.exists(fpath):
            print(f"\n  [MISSING] {fname}")
            continue

        result = analyze_package(fpath)
        if result:
            # Show all names for priority files, all exports
            print_results(result, show_all_names=True, show_all_exports=True)

    # ============================
    # Phase 2: Scan ALL packages for item-related names
    # ============================
    print("\n\n" + "=" * 80)
    print("  PHASE 2: SCANNING ALL PACKAGES FOR ITEM-RELATED KEYWORDS")
    print("=" * 80)

    keywords = ['item', 'shop', 'reward', 'tutorial', 'weapon', 'equip',
                'price', 'cost', 'grade', 'category', 'index']

    matches = scan_all_names_for_keywords(DECRYPTED_DIR, keywords)

    for fname in sorted(matches.keys()):
        print(f"\n  {fname}:")
        for idx, name, kw in matches[fname]:
            print(f"    [{idx:4d}] {name}  (matched: {kw})")

    # ============================
    # Phase 3: Search for weapon code patterns in ZShopItem
    # ============================
    print("\n\n" + "=" * 80)
    print("  PHASE 3: RAW BINARY SEARCH FOR WEAPON CODES IN ZShopItem")
    print("=" * 80)

    shop_path = os.path.join(DECRYPTED_DIR, 'ZShopItem.unr')
    if os.path.exists(shop_path):
        raw_matches = search_raw_for_patterns(shop_path)
        if raw_matches:
            print(f"\n  Found {len(raw_matches)} weapon code references:")
            for offset, code, context in raw_matches[:100]:
                print(f"    0x{offset:06X}: {code}  context: {context}")
        else:
            print("\n  No weapon code patterns found in raw binary.")

    print("\n\nDone.")
