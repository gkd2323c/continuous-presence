/**
 * yaml-parse.js — minimal YAML parser
 *
 * Parses the subset of YAML used by Hanako's added-models.yaml.
 * Supports: nested objects (indentation), key: value pairs,
 * quoted strings, list items with "- ".
 *
 * Not a general-purpose YAML parser — only handles the subset we need.
 */

export function parseYaml(text) {
  const lines = text.split("\n");
  const root = {};

  // Stack entries: { indent, obj }
  // For lists: { indent, obj: theArray, isList: true, listKey }
  const stack = [{ indent: -1, obj: root }];

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    if (!trimmed || trimmed.startsWith("#")) continue;

    const indent = rawLine.length - trimmed.length;

    // Pop stack to correct level
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }

    const currentEntry = stack[stack.length - 1];
    const currentObj = currentEntry.obj;

    // List item: "- value"
    if (trimmed.startsWith("- ")) {
      const value = parseValue(trimmed.slice(2));

      // If we're inside a list context, the current object is already an array
      if (currentEntry.isList) {
        currentObj.push(value);
      } else {
        // First list item at this level: parent should have a key
        // But we don't have the key from here. The previous sibling
        // should have set up the list.
        // Look at the last key in the parent object
        const parentEntry = stack[stack.length - 2];
        const parentObj = parentEntry?.obj || root;
        const keys = Object.keys(parentObj);
        if (keys.length > 0) {
          const lastKey = keys[keys.length - 1];
          const lastVal = parentObj[lastKey];
          if (lastVal === null || lastVal === undefined || (typeof lastVal === 'object' && !Array.isArray(lastVal) && Object.keys(lastVal).length === 0)) {
            // Replace the empty object with an array
            const arr = [value];
            parentObj[lastKey] = arr;
            stack.push({ indent, obj: arr, isList: true });
          } else if (Array.isArray(lastVal)) {
            lastVal.push(value);
            stack.push({ indent, obj: lastVal, isList: true });
          } else {
            // Shouldn't happen for well-formed YAML, but handle gracefully
            if (!Array.isArray(currentObj)) {
              const arr = [value];
              parentObj[lastKey] = arr;
              stack[stack.length - 1] = { indent, obj: arr, isList: true };
            } else {
              currentObj.push(value);
            }
          }
        }
      }
      continue;
    }

    // Key-value or key with nested values
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    const rest = trimmed.slice(colonIdx + 1).trim();

    if (rest === "") {
      // Nested block - could be object or list
      // Create a placeholder empty object; will be replaced by
      // array if the next items are list entries
      const newObj = {};
      currentObj[key] = newObj;
      stack.push({ indent, obj: newObj });
    } else {
      // Key with inline value
      currentObj[key] = parseValue(rest);
    }
  }

  // Clean up: convert empty objects that should be lists
  // (those with _items) to proper arrays
  convertPlaceholders(root);

  return root;
}

function convertPlaceholders(obj) {
  if (obj === null || typeof obj !== "object") return;
  if (Array.isArray(obj)) return;

  for (const key of Object.keys(obj)) {
    const val = obj[key];

    // Check if val has _items (from list items that were orphaned)
    if (val && typeof val === "object" && !Array.isArray(val) && val._items) {
      obj[key] = val._items;
      delete val._items;
    }

    convertPlaceholders(val);
  }
}

function parseValue(value) {
  const trimmed = value.trim();

  // Quoted string
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }

  // Boolean
  if (trimmed === "true" || trimmed === "yes") return true;
  if (trimmed === "false" || trimmed === "no") return false;

  // Null
  if (trimmed === "null" || trimmed === "~") return null;

  // Number
  const num = Number(trimmed);
  if (!isNaN(num) && trimmed !== "") return num;

  // String (default)
  return trimmed;
}
