import type { CustomComponents } from '../types';
import type { Root, Element, ElementContent } from 'hast';

import { mdxExpressionFromMarkdown } from 'mdast-util-mdx-expression';
import { mdxExpression } from 'micromark-extension-mdx-expression';
import rehypeRaw from 'rehype-raw';
import rehypeSlug from 'rehype-slug';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';
import { SKIP, visit } from 'unist-util-visit';
import { VFile } from 'vfile';

import { rehypeMdxishComponents } from '../processor/plugin/mdxish-components';
import { mdxComponentHandlers } from '../processor/plugin/mdxish-handlers';
import calloutTransformer from '../processor/transform/callouts';
import codeTabsTransformer from '../processor/transform/code-tabs';
import embedTransformer from '../processor/transform/embeds';
import gemojiTransformer from '../processor/transform/gemoji+';
import imageTransformer from '../processor/transform/images';
import evaluateExpressions from '../processor/transform/mdxish/evaluate-expressions';
import mdxishComponentBlocks from '../processor/transform/mdxish/mdxish-component-blocks';
import mdxishHtmlBlocks from '../processor/transform/mdxish/mdxish-html-blocks';
import magicBlockRestorer from '../processor/transform/mdxish/mdxish-magic-blocks';
import { processSnakeCaseComponent } from '../processor/transform/mdxish/mdxish-snake-case-components';
import mdxishTables from '../processor/transform/mdxish/mdxish-tables';
import normalizeEmphasisAST from '../processor/transform/mdxish/normalize-malformed-md-syntax';
import { preprocessJSXExpressions, type JSXContext } from '../processor/transform/mdxish/preprocess-jsx-expressions';
import restoreSnakeCaseComponentNames from '../processor/transform/mdxish/restore-snake-case-component-name';
import variablesTextTransformer from '../processor/transform/mdxish/variables-text';
import tailwindTransformer from '../processor/transform/tailwind';

import { extractMagicBlocks } from './utils/extractMagicBlocks';
import { loadComponents } from './utils/mdxish/mdxish-load-components';

export interface MdxishOpts {
  components?: CustomComponents;
  jsxContext?: JSXContext;
  useTailwind?: boolean;
}

const defaultTransformers = [calloutTransformer, codeTabsTransformer, gemojiTransformer, embedTransformer];

/**
 * Rehype plugin that wraps custom components with TailwindRoot at the HAST level.
 * This is a fallback for components that weren't wrapped at the MDAST level
 * (e.g., when mdxishComponentBlocks couldn't convert them to mdxJsxFlowElement).
 */
const rehypeTailwindWrapper = (componentNames: Set<string>) => {
  return (tree: Root) => {
    visit(tree, 'element', (node: Element, index, parent: Element | Root) => {
      if (index === undefined || !parent) return undefined;

      // Check if this is a custom component (PascalCase tag name in our components set)
      const tagName = node.tagName;
      if (!componentNames.has(tagName)) return undefined;

      // Check if already wrapped in TailwindRoot (parent is TailwindRoot)
      if (parent.type === 'element' && (parent as Element).tagName === 'TailwindRoot') {
        return undefined;
      }

      // Check if this node is already a TailwindRoot
      if (tagName === 'TailwindRoot') return undefined;

      // Wrap the component with TailwindRoot
      const wrapper: Element = {
        type: 'element',
        tagName: 'TailwindRoot',
        properties: { flow: true },
        children: [node as ElementContent],
      };

      parent.children.splice(index, 1, wrapper as ElementContent);

      // Skip visiting children of the wrapper to avoid double-wrapping nested components
      return SKIP;
    });
  };
};

/**
 * Process markdown content with MDX syntax support.
 * Detects and renders custom component tags from the components hash.
 *
 * @see {@link https://github.com/readmeio/rmdx/blob/main/docs/mdxish-flow.md}
 */
export function mdxish(mdContent: string, opts: MdxishOpts = {}): Root {
  const { components: userComponents = {}, jsxContext = {}, useTailwind } = opts;

  const components: CustomComponents = {
    ...loadComponents(),
    ...userComponents,
  };

  // Preprocessing pipeline: Transform content to be parser-ready
  // Step 1: Extract legacy magic blocks
  const { replaced: contentAfterMagicBlocks, blocks } = extractMagicBlocks(mdContent);
  // Step 2: Evaluate JSX expressions in attributes
  const contentAfterJSXEvaluation = preprocessJSXExpressions(contentAfterMagicBlocks, jsxContext);
  // Step 3: Replace snake_case component names with parser-safe placeholders
  // (e.g., <Snake_case /> → <MDXishSnakeCase0 /> which will be restored after parsing)
  const { content: parserReadyContent, mapping: snakeCaseMapping } =
    processSnakeCaseComponent(contentAfterJSXEvaluation);

  // Create string map for tailwind transformer
  const tempComponentsMap = Object.entries(components).reduce((acc, [key, value]) => {
    acc[key] = String(value);
    return acc;
  }, {});

  // Create set of component names for HAST-level tailwind wrapper
  const componentNames = new Set(Object.keys(components));

  const processor = unified()
    .data('micromarkExtensions', [mdxExpression({ allowEmpty: true })]) // Parse inline JSX expressions as AST nodes for later evaluation
    .data('fromMarkdownExtensions', [mdxExpressionFromMarkdown()])
    .use(remarkParse)
    .use(remarkFrontmatter)
    .use(normalizeEmphasisAST)
    .use(magicBlockRestorer, { blocks })
    .use(imageTransformer, { isMdxish: true })
    .use(defaultTransformers)
    .use(mdxishComponentBlocks)
    .use(restoreSnakeCaseComponentNames, { mapping: snakeCaseMapping })
    .use(mdxishTables)
    .use(mdxishHtmlBlocks)
    .use(evaluateExpressions, { context: jsxContext }) // Evaluate MDX expressions using jsxContext
    .use(variablesTextTransformer) // Parse {user.*} patterns from text (can't rely on remarkMdx)
    .use(useTailwind ? tailwindTransformer : undefined, { components: tempComponentsMap })
    .use(remarkGfm)
    .use(remarkRehype, { allowDangerousHtml: true, handlers: mdxComponentHandlers })
    .use(rehypeRaw, { passThrough: ['html-block'] })
    .use(rehypeSlug)
    .use(rehypeMdxishComponents, {
      components,
      processMarkdown: (markdown: string) => mdxish(markdown, opts),
    })
    // Fallback: wrap custom components with TailwindRoot at HAST level
    // This catches components that weren't wrapped at MDAST level (e.g., complex nesting structures)
    .use(useTailwind ? () => rehypeTailwindWrapper(componentNames) : undefined);

  const vfile = new VFile({ value: parserReadyContent });
  const hast = processor.runSync(processor.parse(parserReadyContent), vfile) as Root;

  if (!hast) {
    throw new Error('Markdown pipeline did not produce a HAST tree.');
  }

  return hast;
}

export default mdxish;
