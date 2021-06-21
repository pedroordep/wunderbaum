/*!
 * Wunderbaum - ext-filter
 * Copyright (c) 2021, Martin Wendt. Released under the MIT license.
 * @VERSION, @DATE (https://github.com/mar10/wunderbaum)
 */

import {
  debounce,
  elemFromSelector,
  escapeHtml,
  escapeRegex,
  extend,
  extractHtmlText,
  onEvent,
} from "./util";
import { NodeFilterCallback, NodeStatusType } from "./common";
import { Wunderbaum } from "./wunderbaum";
import { WunderbaumNode } from "./wb_node";
import { WunderbaumExtension } from "./wb_extension_base";

const START_MARKER = "\uFFF7";
const END_MARKER = "\uFFF8";
const RE_START_MARKER = new RegExp(escapeRegex(START_MARKER), "g");
const RE_END_MARTKER = new RegExp(escapeRegex(END_MARKER), "g");

export class FilterExtension extends WunderbaumExtension {
  public queryInput?: HTMLInputElement;
  public lastFilterArgs: IArguments | null = null;

  constructor(tree: Wunderbaum) {
    super(tree, "filter", {
      autoApply: true, // Re-apply last filter if lazy data is loaded
      autoExpand: false, // Expand all branches that contain matches while filtered
      counter: true, // Show a badge with number of matching child nodes near parent icons
      fuzzy: false, // Match single characters in order, e.g. 'fb' will match 'FooBar'
      hideExpandedCounter: true, // Hide counter badge if parent is expanded
      hideExpanders: false, // Hide expanders if all child nodes are hidden by filter
      highlight: true, // Highlight matches by wrapping inside <mark> tags
      leavesOnly: false, // Match end nodes only
      mode: "hide", // Grayout unmatched nodes (pass "hide" to remove unmatched node instead)
      noData: true, // Display a 'no data' status node if result is empty
    });
  }

  init() {
    super.init();
    let attachInput = this.getOption("attachInput");
    if (attachInput) {
      this.queryInput = elemFromSelector(attachInput) as HTMLInputElement;
      onEvent(
        this.queryInput,
        "input",
        debounce((e) => {
          // this.tree.log("query", e);
          this.filterNodes(this.queryInput!.value.trim(), {});
        }, 700)
      );
    }
  }

  _applyFilterImpl(
    filter: string | NodeFilterCallback,
    branchMode: boolean,
    _opts: any
  ) {
    let match,
      temp,
      prevEnableUpdate,
      start = Date.now(),
      count = 0,
      tree = this.tree,
      treeOpts = tree.options,
      escapeTitles = treeOpts.escapeTitles,
      prevAutoCollapse = treeOpts.autoCollapse,
      opts = extend({}, treeOpts.filter, _opts),
      hideMode = opts.mode === "hide",
      leavesOnly = !!opts.leavesOnly && !branchMode;

    // Default to 'match title substring (case insensitive)'
    if (typeof filter === "string") {
      if (filter === "") {
        tree.logInfo(
          "Passing an empty string as a filter is handled as clearFilter()."
        );
        this.clearFilter();
        return;
      }
      if (opts.fuzzy) {
        // See https://codereview.stackexchange.com/questions/23899/faster-javascript-fuzzy-string-matching-function/23905#23905
        // and http://www.quora.com/How-is-the-fuzzy-search-algorithm-in-Sublime-Text-designed
        // and http://www.dustindiaz.com/autocomplete-fuzzy-matching
        match = filter
          .split("")
          // Escaping the `filter` will not work because,
          // it gets further split into individual characters. So,
          // escape each character after splitting
          .map(escapeRegex)
          .reduce(function (a, b) {
            // create capture groups for parts that comes before
            // the character
            return a + "([^" + b + "]*)" + b;
          }, "");
      } else {
        match = escapeRegex(filter); // make sure a '.' is treated literally
      }
      let re = new RegExp(match, "i");
      let reHighlight = new RegExp(escapeRegex(filter), "gi");
      filter = (node: WunderbaumNode) => {
        if (!node.title) {
          return false;
        }
        let text = escapeTitles ? node.title : extractHtmlText(node.title);
        // `.match` instead of `.test` to get the capture groups
        let res = text.match(re);

        if (res && opts.highlight) {
          if (escapeTitles) {
            if (opts.fuzzy) {
              temp = _markFuzzyMatchedChars(text, res, escapeTitles);
            } else {
              // #740: we must not apply the marks to escaped entity names, e.g. `&quot;`
              // Use some exotic characters to mark matches:
              temp = text.replace(reHighlight, function (s) {
                return START_MARKER + s + END_MARKER;
              });
            }
            // now we can escape the title...
            node.titleWithHighlight = escapeHtml(temp)
              // ... and finally insert the desired `<mark>` tags
              .replace(RE_START_MARKER, "<mark>")
              .replace(RE_END_MARTKER, "</mark>");
          } else {
            if (opts.fuzzy) {
              node.titleWithHighlight = _markFuzzyMatchedChars(text, res);
            } else {
              node.titleWithHighlight = text.replace(reHighlight, function (s) {
                return "<mark>" + s + "</mark>";
              });
            }
          }
          // node.debug("filter", escapeTitles, text, node.titleWithHighlight);
        }
        return !!res;
      };
    }

    tree.filterMode = opts.mode;
    this.lastFilterArgs = arguments;

    prevEnableUpdate = tree.enableUpdate(false);

    tree.element.classList.toggle("wb-ext-filter-hide", !!hideMode);
    tree.element.classList.toggle("wb-ext-filter-dimm", !hideMode);
    tree.element.classList.toggle(
      "wb-ext-filter-hide-expanders",
      !!opts.hideExpanders
    );
    // Reset current filter
    tree.root.subMatchCount = 0;
    tree.visit((node) => {
      delete node.match;
      delete node.titleWithHighlight;
      node.subMatchCount = 0;
    });
    // statusNode = tree.root.findDirectChild(KEY_NODATA);
    // if (statusNode) {
    //   statusNode.remove();
    // }
    tree.setStatus(NodeStatusType.ok);

    // Adjust node.hide, .match, and .subMatchCount properties
    treeOpts.autoCollapse = false; // #528

    tree.visit((node) => {
      if (leavesOnly && node.children != null) {
        return;
      }
      let res = (<NodeFilterCallback>filter)(node);

      if (res === "skip") {
        node.visit(function (c) {
          c.match = false;
        }, true);
        return "skip";
      }

      let matchedByBranch = false;
      if ((branchMode || res === "branch") && node.parent.match) {
        res = true;
        matchedByBranch = true;
      }

      if (res) {
        count++;
        node.match = true;
        node.visitParents((p) => {
          if (p !== node) {
            p.subMatchCount! += 1;
          }
          // Expand match (unless this is no real match, but only a node in a matched branch)
          if (opts.autoExpand && !matchedByBranch && !p.expanded) {
            p.setExpanded(true, {
              noAnimation: true,
              noEvents: true,
              scrollIntoView: false,
            });
            p._filterAutoExpanded = true;
          }
        }, true);
      }
    });
    treeOpts.autoCollapse = prevAutoCollapse;

    if (count === 0 && opts.noData && hideMode) {
      tree.root.setStatus(NodeStatusType.noData);
    }
    // Redraw whole tree
    tree.enableUpdate(prevEnableUpdate);
    tree.logInfo(
      `Filter '${match}' found ${count} nodes in ${Date.now() - start} ms.`
    );
    return count;
  }

  /**
   * [ext-filter] Dimm or hide nodes.
   *
   * @param {boolean} [opts={autoExpand: false, leavesOnly: false}]
   */
  filterNodes(filter: string | NodeFilterCallback, opts: any) {
    return this._applyFilterImpl(filter, false, opts);
  }

  /**
   * [ext-filter] Dimm or hide whole branches.
   *
   * @param {boolean} [opts={autoExpand: false}]
   */
  filterBranches(filter: string | NodeFilterCallback, opts: any) {
    return this._applyFilterImpl(filter, true, opts);
  }

  /**
   * [ext-filter] Re-apply current filter.
   *
   * @requires jquery.fancytree.filter.js
   */
  updateFilter() {
    let tree = this.tree;
    if (
      tree.filterMode &&
      this.lastFilterArgs &&
      tree.options.filter.autoApply
    ) {
      this._applyFilterImpl.apply(this, <any>this.lastFilterArgs);
    } else {
      tree.logWarn("updateFilter(): no filter active.");
    }
  }

  /**
   * [ext-filter] Reset the filter.
   *
   * @alias Fancytree#clearFilter
   * @requires jquery.fancytree.filter.js
   */
  clearFilter() {
    let tree = this.tree,
      // statusNode = tree.root.findDirectChild(KEY_NODATA),
      escapeTitles = tree.options.escapeTitles,
      // enhanceTitle = tree.options.enhanceTitle,
      prevEnableUpdate = tree.enableUpdate(false);

    // if (statusNode) {
    //   statusNode.remove();
    // }
    tree.setStatus(NodeStatusType.ok);
    // we also counted root node's subMatchCount
    delete tree.root.match;
    delete tree.root.subMatchCount;

    tree.visit((node) => {
      if (node.match && node._rowElem) {
        // #491, #601
        let titleElem = node._rowElem.querySelector("span.wb-title")!;
        if (escapeTitles) {
          titleElem.textContent = node.title;
        } else {
          titleElem.innerHTML = node.title;
        }
        node.callEvent("enhanceTitle", { titleElem: titleElem });
      }
      delete node.match;
      delete node.subMatchCount;
      delete node.titleWithHighlight;
      if (node.subMatchBadge) {
        node.subMatchBadge.remove();
        delete node.subMatchBadge;
      }
      if (node._filterAutoExpanded && node.expanded) {
        node.setExpanded(false, {
          noAnimation: true,
          noEvents: true,
          scrollIntoView: false,
        });
      }
      delete node._filterAutoExpanded;
    });
    tree.filterMode = null;
    this.lastFilterArgs = null;
    tree.element.classList.remove(
      // "wb-ext-filter",
      "wb-ext-filter-dimm",
      "wb-ext-filter-hide"
    );
    // tree._callHook("treeStructureChanged", this, "clearFilter");
    // tree.render();
    tree.enableUpdate(prevEnableUpdate);
  }
}

/**
 * @description Marks the matching charecters of `text` either by `mark` or
 * by exotic*Chars (if `escapeTitles` is `true`) based on `matches`
 * which is an array of matching groups.
 * @param {string} text
 * @param {RegExpMatchArray} matches
 */
function _markFuzzyMatchedChars(
  text: string,
  matches: RegExpMatchArray,
  escapeTitles = false
) {
  let matchingIndices = [];
  // get the indices of matched characters (Iterate through `RegExpMatchArray`)
  for (
    let _matchingArrIdx = 1;
    _matchingArrIdx < matches.length;
    _matchingArrIdx++
  ) {
    let _mIdx: number =
      // get matching char index by cumulatively adding
      // the matched group length
      matches[_matchingArrIdx].length +
      (_matchingArrIdx === 1 ? 0 : 1) +
      (matchingIndices[matchingIndices.length - 1] || 0);
    matchingIndices.push(_mIdx);
  }
  // Map each `text` char to its position and store in `textPoses`.
  let textPoses = text.split("");
  if (escapeTitles) {
    // If escaping the title, then wrap the matchng char within exotic chars
    matchingIndices.forEach(function (v) {
      textPoses[v] = START_MARKER + textPoses[v] + END_MARKER;
    });
  } else {
    // Otherwise, Wrap the matching chars within `mark`.
    matchingIndices.forEach(function (v) {
      textPoses[v] = "<mark>" + textPoses[v] + "</mark>";
    });
  }
  // Join back the modified `textPoses` to create final highlight markup.
  return textPoses.join("");
}
