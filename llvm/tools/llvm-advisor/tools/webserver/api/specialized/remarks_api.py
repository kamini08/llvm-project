# ===----------------------------------------------------------------------===//
#
# Part of the LLVM Project, under the Apache License v2.0 with LLVM Exceptions.
# See https://llvm.org/LICENSE.txt for license information.
# SPDX-License-Identifier: Apache-2.0 WITH LLVM-exception
#
# ===----------------------------------------------------------------------===//

import os
import sys
from collections import defaultdict, Counter
from typing import Dict, Any, List
from pathlib import Path

# Add parent directories to path for imports
current_dir = Path(__file__).parent
tools_dir = current_dir.parent.parent.parent
sys.path.insert(0, str(tools_dir))

from common.models import FileType, Remark
from ..base import APIResponse
from .base_specialized import BaseSpecializedEndpoint


class RemarksEndpoint(BaseSpecializedEndpoint):
    """Specialized endpoints for optimization remarks analysis"""

    def handle_overview(
        self, path_parts: list, query_params: Dict[str, list]
    ) -> Dict[str, Any]:
        """GET /api/remarks/overview - Overall remarks statistics"""
        parsed_data = self.get_parsed_data()

        total_remarks = 0
        pass_distribution = Counter()
        function_distribution = Counter()
        location_distribution = defaultdict(int)

        for unit_name, unit_data in parsed_data.items():
            if FileType.REMARKS in unit_data:
                for parsed_file in unit_data[FileType.REMARKS]:
                    if isinstance(parsed_file.data, list):
                        total_remarks += len(parsed_file.data)

                        for remark in parsed_file.data:
                            if isinstance(remark, Remark):
                                pass_distribution[remark.pass_name] += 1
                                function_distribution[remark.function] += 1

                                if remark.location and remark.location.file:
                                    location_distribution[remark.location.file] += 1

        overview_data = {
            "totals": {
                "remarks": total_remarks,
                "unique_passes": len(pass_distribution),
                "unique_functions": len(function_distribution),
                "source_files": len(location_distribution),
            },
            "top_passes": dict(pass_distribution.most_common(10)),
            "top_functions": dict(function_distribution.most_common(10)),
            "top_files": dict(
                sorted(location_distribution.items(), key=lambda x: x[1], reverse=True)[
                    :10
                ]
            ),
        }

        return APIResponse.success(overview_data)

    def handle_passes(
        self, path_parts: list, query_params: Dict[str, list]
    ) -> Dict[str, Any]:
        """GET /api/remarks/passes - Analysis by optimization passes"""
        parsed_data = self.get_parsed_data()

        passes_data = defaultdict(
            lambda: {"count": 0, "functions": set(), "files": set(), "examples": []}
        )

        for unit_name, unit_data in parsed_data.items():
            if FileType.REMARKS in unit_data:
                for parsed_file in unit_data[FileType.REMARKS]:
                    if isinstance(parsed_file.data, list):
                        for remark in parsed_file.data:
                            if isinstance(remark, Remark):
                                pass_name = remark.pass_name
                                passes_data[pass_name]["count"] += 1
                                passes_data[pass_name]["functions"].add(remark.function)

                                if remark.location and remark.location.file:
                                    passes_data[pass_name]["files"].add(
                                        remark.location.file
                                    )

                                # Keep a few examples
                                if len(passes_data[pass_name]["examples"]) < 3:
                                    example = {
                                        "function": remark.function,
                                        "message": (
                                            remark.message[:100] + "..."
                                            if len(remark.message) > 100
                                            else remark.message
                                        ),
                                        "location": {
                                            "file": (
                                                remark.location.file
                                                if remark.location
                                                else None
                                            ),
                                            "line": (
                                                remark.location.line
                                                if remark.location
                                                else None
                                            ),
                                        },
                                    }
                                    passes_data[pass_name]["examples"].append(example)

        # Convert sets to counts for JSON serialization
        result = {}
        for pass_name, data in passes_data.items():
            result[pass_name] = {
                "count": data["count"],
                "unique_functions": len(data["functions"]),
                "unique_files": len(data["files"]),
                "examples": data["examples"],
            }

        return APIResponse.success({"passes": result, "total_passes": len(result)})

    def handle_functions(
        self, path_parts: list, query_params: Dict[str, list]
    ) -> Dict[str, Any]:
        """GET /api/remarks/functions - Analysis by functions"""
        parsed_data = self.get_parsed_data()

        functions_data = defaultdict(
            lambda: {
                "remarks_count": 0,
                "passes": set(),
                "locations": set(),
                "messages": [],
            }
        )

        for unit_name, unit_data in parsed_data.items():
            if FileType.REMARKS in unit_data:
                for parsed_file in unit_data[FileType.REMARKS]:
                    if isinstance(parsed_file.data, list):
                        for remark in parsed_file.data:
                            if isinstance(remark, Remark):
                                func_name = remark.function
                                functions_data[func_name]["remarks_count"] += 1
                                functions_data[func_name]["passes"].add(
                                    remark.pass_name
                                )

                                if remark.location:
                                    loc_str = (
                                        f"{remark.location.file}:{remark.location.line}"
                                    )
                                    functions_data[func_name]["locations"].add(loc_str)

                                # Keep sample messages
                                if len(functions_data[func_name]["messages"]) < 5:
                                    functions_data[func_name]["messages"].append(
                                        {
                                            "pass": remark.pass_name,
                                            "message": (
                                                remark.message[:150] + "..."
                                                if len(remark.message) > 150
                                                else remark.message
                                            ),
                                        }
                                    )

        # Convert to serializable format
        result = {}
        for func_name, data in functions_data.items():
            result[func_name] = {
                "remarks_count": data["remarks_count"],
                "unique_passes": len(data["passes"]),
                "unique_locations": len(data["locations"]),
                "passes": list(data["passes"]),
                "sample_messages": data["messages"],
            }

        # Sort by remarks count
        sorted_functions = dict(
            sorted(result.items(), key=lambda x: x[1]["remarks_count"], reverse=True)
        )

        return APIResponse.success(
            {"functions": sorted_functions, "total_functions": len(sorted_functions)}
        )

    def handle_hotspots(
        self, path_parts: list, query_params: Dict[str, list]
    ) -> Dict[str, Any]:
        """GET /api/remarks/hotspots - Find optimization hotspots"""
        parsed_data = self.get_parsed_data()

        file_hotspots = defaultdict(
            lambda: {
                "remarks_count": 0,
                "line_distribution": defaultdict(int),
                "passes": set(),
                "functions": set(),
            }
        )

        for unit_name, unit_data in parsed_data.items():
            if FileType.REMARKS in unit_data:
                for parsed_file in unit_data[FileType.REMARKS]:
                    if isinstance(parsed_file.data, list):
                        for remark in parsed_file.data:
                            if (
                                isinstance(remark, Remark)
                                and remark.location
                                and remark.location.file
                            ):
                                file_path = remark.location.file
                                file_hotspots[file_path]["remarks_count"] += 1

                                if remark.location.line:
                                    file_hotspots[file_path]["line_distribution"][
                                        remark.location.line
                                    ] += 1

                                file_hotspots[file_path]["passes"].add(remark.pass_name)
                                file_hotspots[file_path]["functions"].add(
                                    remark.function
                                )

        # Convert to serializable format and find top hotspots
        hotspots = []
        for file_path, data in file_hotspots.items():
            hotspot = {
                "file": file_path,
                "file_name": os.path.basename(file_path),
                "remarks_count": data["remarks_count"],
                "unique_passes": len(data["passes"]),
                "unique_functions": len(data["functions"]),
                "hot_lines": dict(
                    sorted(
                        data["line_distribution"].items(),
                        key=lambda x: x[1],
                        reverse=True,
                    )[:10]
                ),
            }
            hotspots.append(hotspot)

        # Sort by remarks count
        hotspots.sort(key=lambda x: x["remarks_count"], reverse=True)

        return APIResponse.success(
            {
                "hotspots": hotspots[:20],  # Top 20 hotspots
                "total_files_with_remarks": len(hotspots),
            }
        )

    def handle_relational(
        self, path_parts: list, query_params: Dict[str, list]
    ) -> Dict[str, Any]:
        
        unit_filter = query_params.get("unit", [None])[0]
        parsed_data = self.get_parsed_data(unit_filter)

        # Walk compilation units to find every remarks file.
        from common.parsers.remarks_parser import RemarksParser
        parser = RemarksParser()

        # Merged dictionary tables across all units
        merged_files     = {}
        merged_passes    = {}
        merged_functions = {}
        all_rows         = []

        def remap(local_list, global_table):
            mapping = {}
            for local_id, string in enumerate(local_list):
                if string not in global_table:
                    global_table[string] = len(global_table)
                mapping[local_id] = global_table[string]
            return mapping

        for unit_name, unit_data in parsed_data.items():
            if FileType.REMARKS not in unit_data:
                continue
            for parsed_file in unit_data[FileType.REMARKS]:
                relational = parser.parse_relational(parsed_file.file_path)
                if "error" in relational:
                    continue

                d = relational["dictionary"]
                file_remap = remap(d["files"],     merged_files)
                pass_remap = remap(d["passes"],    merged_passes)
                func_remap = remap(d["functions"], merged_functions)

                for row in relational["remarks"]:
                    all_rows.append([
                        file_remap[row[0]],
                        pass_remap[row[1]],
                        func_remap[row[2]],
                        row[3],
                        row[4],
                        row[5],
                        row[6],
                        row[7],
                        row[8],
                        row[9],
                    ])

        def invert(table):
            result = [""] * len(table)
            for string, idx in table.items():
                result[idx] = string
            return result

        return APIResponse.success({
            "dictionary": {
                "files":     invert(merged_files),
                "passes":    invert(merged_passes),
                "functions": invert(merged_functions),
            },
            "remarks": all_rows,
            "meta": {
                "total":  len(all_rows),
                "schema": ["file_id", "pass_id", "func_id", "line", "col",
                           "hotness", "rtype", "name", "message", "args"],
                "rtype_legend": {"0": "Passed", "1": "Missed", "2": "Analysis"},
            }
        })

    def handle_loop_clusters(
        self, path_parts: list, query_params: Dict[str, list]
    ) -> Dict[str, Any]:

        unit_filter = query_params.get("unit", [None])[0]
        radius      = int((query_params.get("radius") or ["5"])[0])
        parsed_data = self.get_parsed_data(unit_filter)

        # cluster_key -> cluster dict
        clusters = {}

        for unit_name, unit_data in parsed_data.items():
            if FileType.REMARKS not in unit_data:
                continue
            for parsed_file in unit_data[FileType.REMARKS]:
                if not isinstance(parsed_file.data, list):
                    continue
                for remark in parsed_file.data:
                    if not isinstance(remark, Remark):
                        continue
                    if not remark.location or not remark.location.line:
                        continue

                    func  = remark.function or "unknown"
                    line  = remark.location.line
                    # Round line to nearest radius boundary to group adjacent
                    # remarks that belong to the same loop body
                    anchor = (line // radius) * radius
                    key    = f"{func}@{anchor}"

                    if key not in clusters:
                        clusters[key] = {
                            "cluster_id":   key,
                            "function":     func,
                            "anchor_line":  anchor,
                            "line_min":     line,
                            "line_max":     line,
                            "file":         remark.location.file or "unknown",
                            "heat_score":   0,
                            "remark_count": 0,
                            "missed_count": 0,
                            "passes":       {},
                            "top_missed":   [],
                            "has_pgo":      False,
                        }

                    c = clusters[key]
                    c["line_min"]     = min(c["line_min"], line)
                    c["line_max"]     = max(c["line_max"], line)
                    c["remark_count"] += 1

                    # PGO hotness
                    hotness = 0  # hotness not stored on Remark dataclass; rely on static heuristics
                    if hotness:
                        c["heat_score"] += hotness
                        c["has_pgo"]     = True

                    # static fallback: missed/analysis remarks weight more
                    is_missed = (
                        "not vectorized" in (remark.message or "").lower()
                        or "not unrolled" in (remark.message or "").lower()
                        or "not inlined" in (remark.message or "").lower()
                    )
                    if is_missed:
                        c["missed_count"] += 1
                        if not c["has_pgo"]:
                            c["heat_score"] += 2

                    if not c["has_pgo"]:
                        c["heat_score"] += 1

                    # Pass breakdown
                    pname = remark.pass_name
                    c["passes"][pname] = c["passes"].get(pname, 0) + 1

        result = sorted(clusters.values(), key=lambda x: x["heat_score"], reverse=True)

        for c in result:
            c["top_missed"] = sorted(
                c["passes"].items(), key=lambda x: x[1], reverse=True
            )[:3]
            c["top_missed"] = [{"pass": p, "count": n} for p, n in c["top_missed"]]

        return APIResponse.success({
            "clusters": result[:50],
            "total_clusters": len(result),
            "tier": "pgo" if any(c["has_pgo"] for c in result) else "static_heuristic",
            "radius_used": radius,
        })

    def handle_diff(
        self, path_parts: list, query_params: Dict[str, list]
    ) -> Dict[str, Any]:

        baseline_unit = query_params.get("baseline", [None])[0]
        target_unit   = query_params.get("target",   [None])[0]

        if not baseline_unit or not target_unit:
            return APIResponse.invalid_request(
                "Both 'baseline' and 'target' query parameters are required. "
                "Example: /api/remarks/diff?baseline=unit_a&target=unit_b"
            )

        baseline_data = self.get_parsed_data(baseline_unit)
        target_data   = self.get_parsed_data(target_unit)

        BUCKET = 5

        def build_key_map(parsed_data):
            """
            Returns dict: composite_key -> {"message": str, "args": any}
            composite_key = (pass_name, remark_name, function, line_bucket)
            """
            key_map = {}
            for unit_name, unit_data in parsed_data.items():
                if FileType.REMARKS not in unit_data:
                    continue
                for parsed_file in unit_data[FileType.REMARKS]:
                    if not isinstance(parsed_file.data, list):
                        continue
                    for remark in parsed_file.data:
                        if not isinstance(remark, Remark):
                            continue
                        line   = (remark.location.line or 0) if remark.location else 0
                        bucket = (line // BUCKET) * BUCKET
                        name   = remark.message.split(":")[0] if remark.message else ""
                        key    = (
                            remark.pass_name,
                            name,
                            remark.function,
                            bucket,
                        )
                        key_map[key] = {
                            "message": remark.message,
                            "args":    remark.args,
                            "file":    remark.location.file if remark.location else None,
                            "line":    line,
                        }
            return key_map

        baseline_map = build_key_map(baseline_data)
        target_map   = build_key_map(target_data)

        baseline_keys = set(baseline_map.keys())
        target_keys   = set(target_map.keys())

        def fmt_key(k):
            return {"pass": k[0], "remark": k[1], "function": k[2], "line_bucket": k[3]}

        resolved  = []
        regressed = []
        mutated   = []

        for k in baseline_keys - target_keys:
            resolved.append({
                "key":      fmt_key(k),
                "baseline": baseline_map[k],
            })

        for k in target_keys - baseline_keys:
            regressed.append({
                "key":    fmt_key(k),
                "target": target_map[k],
            })

        for k in baseline_keys & target_keys:
            b = baseline_map[k]
            t = target_map[k]
            if b["message"] != t["message"] or b["args"] != t["args"]:
                mutated.append({
                    "key":      fmt_key(k),
                    "baseline": b,
                    "target":   t,
                })

        return APIResponse.success({
            "summary": {
                "resolved":  len(resolved),
                "regressed": len(regressed),
                "mutated":   len(mutated),
                "unchanged": len(baseline_keys & target_keys) - len(mutated),
            },
            "resolved":  resolved[:100],
            "regressed": regressed[:100],
            "mutated":   mutated[:100],
        })

