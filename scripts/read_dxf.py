#!/usr/bin/env python3
"""读取 DXF 文件并输出 JSON（供 DSH dwg-reader 插件调用）。"""
import sys
import json
import os

try:
    import ezdxf
except ImportError as exc:
    print(json.dumps({"error": f"ezdxf 未安装: {exc}"}))
    sys.exit(1)

DXF_PATH = sys.argv[1] if len(sys.argv) > 1 else None
ENTITY_LIMIT = int(sys.argv[2]) if len(sys.argv) > 2 else 200
WANT_ENTITIES = sys.argv[3] == "true" if len(sys.argv) > 3 else False


def point_to_list(p):
    if p is None:
        return None
    return [float(p.x), float(p.y), float(p.z)]


def main():
    if not DXF_PATH or not os.path.exists(DXF_PATH):
        print(json.dumps({"error": f"文件不存在: {DXF_PATH}"}))
        sys.exit(1)

    try:
        doc = ezdxf.readfile(DXF_PATH)
    except Exception as exc:
        print(json.dumps({"error": f"无法读取 DXF: {exc}"}))
        sys.exit(1)

    # 图层
    layers = []
    for layer in doc.layers:
        layers.append({
            "name": layer.dxf.name,
            "colorIndex": layer.dxf.color,
            "lineType": layer.dxf.linetype,
            "frozen": bool(layer.is_frozen()),
            "off": bool(layer.is_off()),
            "locked": bool(layer.is_locked()),
        })

    # 块记录
    block_count = len(list(doc.blocks))

    # 实体统计
    msp = doc.modelspace()
    entities = list(msp)
    entity_type_counts = {}
    entity_details = []
    for ent in entities:
        etype = ent.dxftype() or "UNKNOWN"
        entity_type_counts[etype] = entity_type_counts.get(etype, 0) + 1
        if WANT_ENTITIES and len(entity_details) < ENTITY_LIMIT:
            detail = {
                "type": etype,
                "handle": ent.dxf.handle if hasattr(ent.dxf, 'handle') else None,
                "layer": ent.dxf.layer if hasattr(ent.dxf, 'layer') else None,
                "colorIndex": ent.dxf.color if hasattr(ent.dxf, 'color') else None,
                "lineType": ent.dxf.linetype if hasattr(ent.dxf, 'linetype') else None,
            }
            if etype == "INSERT":
                detail["blockName"] = ent.dxf.name if hasattr(ent.dxf, 'name') else None
                detail["insertionPoint"] = point_to_list(ent.dxf.insert) if hasattr(ent.dxf, 'insert') else None
            entity_details.append(detail)

    # 图头
    header = {}
    try:
        header_vars = doc.header
        for key in ("$ACADVER", "$DWGCODEPAGE", "$INSUNITS", "$EXTMIN", "$EXTMAX", "$TDCREATE", "$TDUPDATE", "$CLAYER"):
            if key in header_vars:
                val = header_vars[key]
                if key == "$EXTMIN" or key == "$EXTMAX":
                    header[key] = point_to_list(val) if val else None
                else:
                    header[key] = str(val)
    except Exception:
        pass

    result = {
        "path": os.path.abspath(DXF_PATH),
        "fileName": os.path.basename(DXF_PATH),
        "fileSizeBytes": os.path.getsize(DXF_PATH),
        "format": "dxf",
        "dxfVersion": doc.dxfversion,
        "header": header,
        "layerCount": len(layers),
        "layers": layers,
        "blockCount": block_count,
        "entityCount": len(entities),
        "entityTypeCounts": entity_type_counts,
        "entities": entity_details,
        "entitiesTruncated": WANT_ENTITIES and len(entities) > ENTITY_LIMIT,
    }
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
