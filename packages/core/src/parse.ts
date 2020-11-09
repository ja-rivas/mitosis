import * as babel from '@babel/core';
import generate from '@babel/generator';
import JSON5 from 'json5';
import { JSXLiteNode } from './types/jsx-lite-node';
import { JSONObject, JSONOrNode, JSONOrNodeObject } from './types/json';
import { createJSXLiteNode } from './helpers/create-jsx-lite-node';
import { JSXLiteComponent, JSXLiteImport } from './types/jsx-lite-component';

const jsxPlugin = require('@babel/plugin-syntax-jsx');

export const selfClosingTags = new Set(['input', 'meta', 'bar']);

const { types } = babel;

const arrayToAst = (array: JSONOrNode[]) => {
  return types.arrayExpression(array.map((item) => jsonToAst(item)) as any);
};

const jsonToAst = (json: JSONOrNode): babel.Node => {
  if (types.isNode(json as any)) {
    if (types.isJSXText(json as any)) {
      return types.stringLiteral((json as any).value);
    }
    return json as babel.Node;
  }
  switch (typeof json) {
    case 'undefined':
      return types.identifier('undefined');
    case 'string':
      return types.stringLiteral(json);
    case 'number':
      return types.numericLiteral(json);
    case 'boolean':
      return types.booleanLiteral(json);
    case 'object':
      if (!json) {
        return types.nullLiteral();
      }
      if (Array.isArray(json)) {
        return arrayToAst(json);
      }
      return jsonObjectToAst(json as JSONObject);
  }
};

const jsonObjectToAst = (
  json: JSONOrNodeObject,
): babel.types.ObjectExpression => {
  if (!json) {
    return json;
  }
  const properties: babel.types.ObjectProperty[] = [];
  for (const key in json) {
    const value = json[key];
    if (value === undefined) {
      continue;
    }
    const keyAst = types.stringLiteral(key);
    const valueAst = jsonToAst(value);
    properties.push(types.objectProperty(keyAst, valueAst as any));
  }
  const newNode = types.objectExpression(properties);

  return newNode;
};

const componentFunctionToJson = (
  node: babel.types.FunctionDeclaration,
  context: any,
): JSONOrNode => {
  let state = {};
  for (const item of node.body.body) {
    if (types.isVariableDeclaration(item)) {
      const init = item.declarations[0].init;
      if (types.isCallExpression(init)) {
        const firstArg = init.arguments[0];
        if (types.isObjectExpression(firstArg)) {
          const obj = JSON5.parse(generate(firstArg).code);
          state = obj;
        }
      }
    }
  }

  const theReturn = node.body.body.find((item) =>
    types.isReturnStatement(item),
  );
  const children: JSXLiteNode[] = [];
  if (theReturn) {
    const value = (theReturn as babel.types.ReturnStatement).argument;
    if (types.isJSXElement(value)) {
      children.push(jsxElementToJson(value) as JSXLiteNode);
    }
  }

  return {
    '@type': '@jsx-lite/component',
    imports: (context.builder && context.builder.imports) || [],
    state,
    children,
  };
};

const jsxElementToJson = (
  node: babel.types.JSXElement | babel.types.JSXText,
): JSXLiteNode => {
  if (types.isJSXText(node)) {
    return createJSXLiteNode({
      properties: {
        _text: node.value,
      },
    });
  }
  return createJSXLiteNode({
    name: (node.openingElement.name as babel.types.JSXIdentifier).name,
    properties: node.openingElement.attributes.reduce((memo, item) => {
      if (types.isJSXAttribute(item)) {
        const key = item.name.name as string;
        const value = item.value;
        if (types.isStringLiteral(value)) {
          memo[key] = value;
          return memo;
        }
      }
      return memo;
    }, {} as { [key: string]: JSONOrNode }) as any,
    bindings: node.openingElement.attributes.reduce((memo, item) => {
      if (types.isJSXAttribute(item)) {
        const key = item.name.name as string;
        const value = item.value;

        if (types.isJSXExpressionContainer(value)) {
          const { expression } = value;
          if (types.isArrowFunctionExpression(expression)) {
            memo[key] = generate(expression.body).code;
          } else {
            memo[key] = generate(expression).code;
          }
          return memo;
        }
      }
      return memo;
    }, {} as { [key: string]: JSONOrNode }) as any,
    children: node.children.map((item) => jsxElementToJson(item as any)) as any,
  });
};

export function parse(jsx: string): JSXLiteComponent {
  const output = babel.transform(jsx, {
    plugins: [
      jsxPlugin,
      () => ({
        visitor: {
          FunctionDeclaration(
            path: babel.NodePath<babel.types.FunctionDeclaration>,
            context: any,
          ) {
            const { node } = path;
            if (types.isIdentifier(node.id)) {
              const name = node.id.name;
              if (name[0].toUpperCase() === name[0]) {
                path.replaceWith(
                  jsonToAst(componentFunctionToJson(node, context)),
                );
              }
            }
          },
          ImportDeclaration(
            path: babel.NodePath<babel.types.ImportDeclaration>,
            context: any,
          ) {
            if (!context.builder) {
              context.builder = {};
            }
            if (!context.builder.imports) {
              context.builder.imports = [];
            }
            const importObject: JSXLiteImport = {
              imports: {},
              path: path.node.source.value,
            };
            for (const specifier of path.node.specifiers) {
              if (types.isImportSpecifier(specifier)) {
                importObject.imports[
                  (specifier.imported as babel.types.Identifier).name
                ] = specifier.local.name;
              } else if (types.isImportDefaultSpecifier(specifier)) {
                importObject.imports[specifier.local.name] = 'default';
              } else if (types.isImportNamespaceSpecifier(specifier)) {
                importObject.imports[specifier.local.name] = '*';
              }
            }
            context.builder.imports.push(importObject);
            // console.log('context 1', context);
            path.remove();
          },
          ExportDefaultDeclaration(
            path: babel.NodePath<babel.types.ExportDefaultDeclaration>,
          ) {
            path.replaceWith(path.node.declaration);
          },
          JSXText(path: babel.NodePath<babel.types.JSXText>) {
            path.replaceWith(types.stringLiteral(path.node.value));
          },
          JSXElement(path: babel.NodePath<babel.types.JSXElement>) {
            const { node } = path;
            path.replaceWith(jsonToAst(jsxElementToJson(node)));
          },
        },
      }),
    ],
  });

  // To debug:
  // console.log(output!.code!);

  return JSON5.parse(output!.code!.replace('({', '{').replace('});', '}'));
}