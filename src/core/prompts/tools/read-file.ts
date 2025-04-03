import { ToolArgs } from "./types"

export function getReadFileDescription(args: ToolArgs): string {
	return `## read_file
Description: Request to read the contents of a file at the specified path. Use this when you need to examine the contents of an existing file you do not know the contents of, for example to analyze code, review text files, or extract information from configuration files. The output includes line numbers prefixed to each line (e.g. "1 | const x = 1"), making it easier to reference specific lines when creating diffs or discussing code. By specifying start_line and end_line parameters, you can efficiently read specific portions of large files without loading the entire file into memory. Automatically extracts raw text from PDF and DOCX files. May not be suitable for other types of binary files, as it returns the raw content as a string.
Parameters:
- path: (required) The path of the file to read (relative to the current working directory ${args.cwd})
- start_line: (optional) The starting line number to read from (1-based). If not provided, it starts from the beginning of the file.
- end_line: (optional) The ending line number to read to (1-based, inclusive). If not provided, it reads to the end of the file.
- auto_truncate: (optional) Whether to automatically truncate large files when start_line and end_line are not specified. If true and the file exceeds a certain line threshold, it will: a) return only a subset of lines to save tokens, b) include information about the total line count, and c) provide a summary of method definitions with their line ranges. You should set this to true unless you've been explicitly asked to read an entire large file at once, as this prevents context bloat that can lead to truncated responses. For backwards compatibility, it defaults to false when omitted.
Usage:
<read_file>
<path>File path here</path>
<start_line>Starting line number (optional)</start_line>
<end_line>Ending line number (optional)</end_line>
<auto_truncate>true or false (optional)</auto_truncate>
</read_file>

Examples:

1. Reading an entire file:
<read_file>
<path>frontend-config.json</path>
</read_file>

2. Reading the first 1000 lines of a large log file:
<read_file>
<path>logs/application.log</path>
<end_line>1000</end_line>
</read_file>

3. Reading lines 500-1000 of a CSV file:
<read_file>
<path>data/large-dataset.csv</path>
<start_line>500</start_line>
<end_line>1000</end_line>
</read_file>

4. Reading a specific function in a source file:
<read_file>
<path>src/app.ts</path>
<start_line>46</start_line>
<end_line>68</end_line>
</read_file>
Note: When both start_line and end_line are provided, this tool efficiently streams only the requested lines, making it suitable for processing large files like logs, CSV files, and other large datasets without memory issues.

5. Reading a large file with automatic truncation:
<read_file>
<path>src/large-module.ts</path>
<auto_truncate>true</auto_truncate>
</read_file>

This will return a truncated version of the file with information about total line count and method definitions, helping to prevent context size issues with very large files.`
}
