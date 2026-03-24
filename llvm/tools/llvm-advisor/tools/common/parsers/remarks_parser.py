# ===----------------------------------------------------------------------===//
#
# Part of the LLVM Project, under the Apache License v2.0 with LLVM Exceptions.
# See https://llvm.org/LICENSE.txt for license information.
# SPDX-License-Identifier: Apache-2.0 WITH LLVM-exception
#
# ===----------------------------------------------------------------------===//

import yaml
from typing import List, Dict, Any
from .base_parser import BaseParser
from ..models import FileType, ParsedFile, Remark, SourceLocation


class RemarksParser(BaseParser):
    def __init__(self):
        super().__init__(FileType.REMARKS)

    def parse(self, file_path: str) -> ParsedFile:
        content = self.read_file_safe(file_path)
        if content is None:
            return self.create_parsed_file(
                file_path, [], {"error": "File too large or unreadable"}
            )

        try:
            remarks = []
            # Handle custom YAML tags by creating a loader
            loader = type('AdvisorLoader', (yaml.SafeLoader,), {})

            def make_tag_ctor(tag):
                def ctor(l, node):
                    d = l.construct_mapping(node)
                    d["__tag__"] = tag
                    return d
                return ctor

            for _tag in ["!Passed", "!Missed", "!Analysis"]:
                loader.add_constructor(_tag, make_tag_ctor(_tag))

            # Catch-all: handles !AnalysisFPCommute, !AnalysisAliasing, etc.
            def catch_all(l, node):
                try:
                    d = l.construct_mapping(node)
                except Exception:
                    d = {}
                d["__tag__"] = node.tag
                return d

            loader.add_constructor(None, catch_all)

            yaml_docs = yaml.load_all(content, Loader=loader)

            for doc in yaml_docs:
                if not doc:
                    continue

                remark = self._parse_remark(doc)
                if remark:
                    remarks.append(remark)

            metadata = {
                "total_remarks": len(remarks),
                "file_size": self.get_file_size(file_path),
            }

            return self.create_parsed_file(file_path, remarks, metadata)

        except Exception as e:
            return self.create_parsed_file(file_path, [], {"error": str(e)})

    def _parse_remark(self, doc: Dict[str, Any]) -> Remark:
        try:
            pass_name = doc.get("Pass", "")
            function = doc.get("Function", "")

            # Extract location information
            location = None
            debug_loc = doc.get("DebugLoc")
            if debug_loc:
                location = SourceLocation(
                    file=debug_loc.get("File"),
                    line=debug_loc.get("Line"),
                    column=debug_loc.get("Column"),
                )

            # Build message from args or use Name
            message = doc.get("Name", "")
            args = doc.get("Args", [])
            if args:
                arg_strings = []
                for arg in args:
                    if isinstance(arg, dict) and "String" in arg:
                        arg_strings.append(arg["String"])
                    elif isinstance(arg, str):
                        arg_strings.append(arg)
                if arg_strings:
                    message = "".join(arg_strings)

            return Remark(
                pass_name=pass_name,
                function=function,
                message=message,
                location=location,
                args=doc.get("Args", {}),
            )
        except Exception:
            return None

    def parse_relational(self, file_path: str) -> dict:
       
        content = self.read_file_safe(file_path)
        if content is None:
            return {"error": "File too large or unreadable"}

        # String interning tables: value -> integer id
        file_table   = {}
        pass_table   = {}
        func_table   = {}

        TYPE_MAP = {"!Passed": 0, "!Missed": 1, "!Analysis": 2}

        def intern(table, value):
            if value not in table:
                table[value] = len(table)
            return table[value]

        rows = []

        try:
            loader = type("RelationalLoader", (yaml.SafeLoader,), {})

            def make_tagged_constructor(tag):
                def constructor(l, node):
                    d = l.construct_mapping(node)
                    d["__tag__"] = tag
                    return d
                return constructor

            for _tag in ["!Passed", "!Missed", "!Analysis"]:
                loader.add_constructor(_tag, make_tagged_constructor(_tag))

            def catch_all(l, node):
                try:
                    d = l.construct_mapping(node)
                except Exception:
                    d = {}
                d["__tag__"] = node.tag
                return d

            loader.add_constructor(None, catch_all)

            for doc in yaml.load_all(content, Loader=loader):
                if not doc:
                    continue

                tag      = doc.get("__tag__", "!Analysis")
                rtype    = TYPE_MAP.get(tag, 2)

                pass_name   = doc.get("Pass", "unknown")
                func_name   = doc.get("Function", "unknown")
                remark_name = doc.get("Name", "")

                debug_loc = doc.get("DebugLoc") or {}
                src_file  = debug_loc.get("File", "unknown")
                line      = debug_loc.get("Line", 0) or 0
                col       = debug_loc.get("Column", 0) or 0
                hotness   = doc.get("Hotness", 0) or 0

                # Reconstruct human-readable message from Args
                args = doc.get("Args", []) or []
                message_parts = []
                for arg in args:
                    if isinstance(arg, dict) and "String" in arg:
                        message_parts.append(arg["String"])
                    elif isinstance(arg, str):
                        message_parts.append(arg)
                message = "".join(message_parts) if message_parts else remark_name

                encoded_args = []
                for arg in args:
                    if isinstance(arg, dict):
                        for k, v in arg.items():
                            if k != "DebugLoc" and k != "String":
                                encoded_args.append({k: str(v)})

                rows.append([
                    intern(file_table,   src_file),   
                    intern(pass_table,   pass_name),  
                    intern(func_table,   func_name),  
                    line,                             
                    col,                              
                    hotness,                          
                    rtype,                            
                    remark_name,                      
                    message,
                    encoded_args,                     
                ])

        except Exception as e:
            return {"error": str(e), "dictionary": {}, "remarks": []}

        def invert(table):
            result = [""] * len(table)
            for string, idx in table.items():
                result[idx] = string
            return result

        return {
            "dictionary": {
                "files":     invert(file_table),
                "passes":    invert(pass_table),
                "functions": invert(func_table),
            },
            "remarks": rows,
            "meta": {
                "total": len(rows),
                "source_file": file_path,
            }
        }
