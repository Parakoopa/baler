import { Parser } from 'htmlparser2';
import * as acorn from 'acorn';

type ParserResult = {
    deps: string[];
    warnings: string[];
};

/**
 * @summary Given contents from a .phtml or .html file from Magento,
 *          will return all JavaScript dependencies. Sources include:
 *          - x-magento-init
 *          - data-mage-init
 *          - mageInit knockout directive
 *          - require() call (TODO)
 *          - define() call (TODO)
 * @see https://devdocs.magento.com/guides/v2.3/javascript-dev-guide/javascript/js_init.html
 */
export function parse(input: string): ParserResult {
    const collector = new NodeCollector();
    const parser = new Parser(collector, {
        lowerCaseTags: true,
        lowerCaseAttributeNames: true,
    });
    const cleanedInput = replacePHPDelimiters(input);
    parser.write(cleanedInput);

    return {
        deps: collector.deps,
        warnings: collector.warnings,
    };
}

/**
 * @summary Implements htmlparser2's `Handler` interface
 *          and collects all forms of mage-init directives
 */
class NodeCollector {
    deps: string[];
    warnings: string[];
    inScript: boolean;
    buffer: string;

    constructor() {
        this.deps = [];
        this.warnings = [];
        this.inScript = false;
        this.buffer = '';
    }

    onopentag(name: string, attribs: Record<string, string>) {
        const dataMageInit = attribs['data-mage-init'];
        const dataBind = attribs['data-bind'];

        if (dataMageInit) {
            try {
                this.deps.push(
                    ...extractDepsFromDataMageInitAttr(dataMageInit),
                );
            } catch {
                this.warnings.push(dataMageInit);
            }
        }

        if (dataBind && dataBind.includes('mageInit')) {
            try {
                this.deps.push(...extractMageInitDepsFromDataBind(dataBind));
            } catch {
                this.warnings.push(dataBind);
            }
        }

        if (name === 'script' && attribs.type === 'text/x-magento-init') {
            this.inScript = true;
        }
    }

    ontext(value: string) {
        if (!this.inScript) return;
        this.buffer += value;
    }

    onclosetag() {
        if (this.inScript) {
            this.inScript = false;
            try {
                this.deps.push(...extractDepsFromXMagentoInit(this.buffer));
            } catch {
                this.warnings.push(this.buffer);
            }
            this.buffer = '';
        }
    }
}

/**
 * @summary Get just the `mageInit` key from a `data-bind` attribute
 *          for knockout. This is challening because the value is
 *          neither valid JSON or valid JavaScript, and there can
 *          be multiple comma-separated values. Wrapping the
 *          value in `({ valuehere })` makes it a valid
 *          JavaScript object expression. So, we wrap, parse,
 *          modify the AST to only include the `mageInit` key, then we
 *          stringify back to JavaScript, and use json5 to parse the
 *          code that is now valid JavaScript, but not valid JSON
 */
function extractMageInitDepsFromDataBind(attrValue: string): string[] {
    const valueWrappedAsObjectLiteral = `({${attrValue}})`;
    const ast = acorn.parse(valueWrappedAsObjectLiteral);
    // @ts-ignore missing types for AST from acorn
    const objExpression = ast.body[0].expression;
    const mageInitProp = objExpression.properties.find(
        (p: any) => p.key.name === 'mageInit',
    );

    const deps = mageInitProp.value.properties.map((p: any) => {
        return p.key.value;
    });

    return deps;
}

function extractDepsFromDataMageInitAttr(attrValue: string): string[] {
    return getASTFromObjectLiteral(attrValue).properties.map(
        (p: any) => p.key.value,
    );
}

/**
 * @summary Replace PHP delimiters (and their contents)
 *          with placeholder values that will not break HTML parsing.
 *          In multiple places in Magento, an HTML attribute will
 *          be opened with a single quote, and then a single quote
 *          will be used within <?= ?> tags. This breaks proper HTML
 *          attribute parsing
 */
function replacePHPDelimiters(input: string) {
    return input.replace(/(<\?(?:=|php)[\s\S]+?\?>)/g, 'PHP_DELIM_PLACEHOLDER');
}

function extractDepsFromXMagentoInit(input: string): string[] {
    const objExpression = getASTFromObjectLiteral(input);
    const deps: string[] = [];

    for (const selector of objExpression.properties) {
        const newDeps = selector.value.properties.map((p: any) => p.key.value);
        deps.push(...newDeps);
    }

    return deps;
}

/**
 * @summary Get an ESTree AST from an object literal in source text.
 */
function getASTFromObjectLiteral(input: string) {
    // An opening brace in statement-position is parsed as
    // a block, so we force an expression by wrapping in parens
    const valueWrappedAsObjectLiteral = `(${input})`;
    const ast = acorn.parse(valueWrappedAsObjectLiteral);
    // @ts-ignore missing types for AST from acorn
    return ast.body[0].expression;
}
