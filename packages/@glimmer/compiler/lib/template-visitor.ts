import { AST } from '@glimmer/syntax';
import { Core } from '@glimmer/wire-format';
import { Dict, Option, dict, unreachable, expect } from '@glimmer/util';

export abstract class SymbolTable {
  static top(): ProgramSymbolTable {
    return new ProgramSymbolTable();
  }

  abstract has(name: string): boolean;
  abstract get(name: string): number;

  abstract getLocalsMap(): Dict<number>;
  abstract getEvalInfo(): Core.EvalInfo;

  abstract allocateNamed(name: string): number;
  abstract allocateBlock(name: string): number;
  abstract allocate(identifier: string): number;

  child(locals: string[]): BlockSymbolTable {
    let symbols = locals.map(name => this.allocate(name));
    return new BlockSymbolTable(this, locals, symbols);
  }
}

export class ProgramSymbolTable extends SymbolTable {
  public symbols: string[] = [];

  private size = 1;
  private named = dict<number>();
  private blocks = dict<number>();

  has(_name: string): boolean {
    return false;
  }

  get(_name: string): never {
    throw unreachable();
  }

  getLocalsMap(): Dict<number> {
    return {};
  }

  getEvalInfo(): Core.EvalInfo {
    return [];
  }

  allocateNamed(name: string): number {
    let named = this.named[name];

    if (!named) {
      named = this.named[name] = this.allocate(`@${name}`);
    }

    return named;
  }

  allocateBlock(name: string): number {
    let block = this.blocks[name];

    if (!block) {
      block = this.blocks[name] = this.allocate(`&${name}`);
    }

    return block;
  }

  allocate(identifier: string): number {
    this.symbols.push(identifier);
    return this.size++;
  }
}

export class BlockSymbolTable extends SymbolTable {
  constructor(private parent: SymbolTable, public symbols: string[], public slots: number[]) {
    super();
  }

  has(name: string): boolean {
    return (this.symbols.indexOf(name) !== -1) || this.parent.has(name);
  }

  get(name: string): number {
    let slot = this.symbols.indexOf(name);
    return slot === -1 ? this.parent.get(name) : this.slots[slot];
  }

  getLocalsMap(): Dict<number> {
    let dict = this.parent.getLocalsMap();
    this.symbols.forEach(symbol => dict[symbol] = this.get(symbol));
    return dict;
  }

  getEvalInfo(): Core.EvalInfo {
    let locals = this.getLocalsMap();
    return Object.keys(locals).map(symbol => locals[symbol]);
  }

  allocateNamed(name: string): number {
    return this.parent.allocateNamed(name);
  }

  allocateBlock(name: string): number {
    return this.parent.allocateBlock(name);
  }

  allocate(identifier: string): number {
    return this.parent.allocate(identifier);
  }
}

/**
 * Takes in an AST and outputs a list of actions to be consumed
 * by a compiler. For example, the template
 *
 *     foo{{bar}}<div>baz</div>
 *
 * produces the actions
 *
 *     [['startProgram', [programNode, 0]],
 *      ['text', [textNode, 0, 3]],
 *      ['mustache', [mustacheNode, 1, 3]],
 *      ['openElement', [elementNode, 2, 3, 0]],
 *      ['text', [textNode, 0, 1]],
 *      ['closeElement', [elementNode, 2, 3],
 *      ['endProgram', [programNode]]]
 *
 * This visitor walks the AST depth first and backwards. As
 * a result the bottom-most child template will appear at the
 * top of the actions list whereas the root template will appear
 * at the bottom of the list. For example,
 *
 *     <div>{{#if}}foo{{else}}bar<b></b>{{/if}}</div>
 *
 * produces the actions
 *
 *     [['startProgram', [programNode, 0]],
 *      ['text', [textNode, 0, 2, 0]],
 *      ['openElement', [elementNode, 1, 2, 0]],
 *      ['closeElement', [elementNode, 1, 2]],
 *      ['endProgram', [programNode]],
 *      ['startProgram', [programNode, 0]],
 *      ['text', [textNode, 0, 1]],
 *      ['endProgram', [programNode]],
 *      ['startProgram', [programNode, 2]],
 *      ['openElement', [elementNode, 0, 1, 1]],
 *      ['block', [blockNode, 0, 1]],
 *      ['closeElement', [elementNode, 0, 1]],
 *      ['endProgram', [programNode]]]
 *
 * The state of the traversal is maintained by a stack of frames.
 * Whenever a node with children is entered (either a ProgramNode
 * or an ElementNode) a frame is pushed onto the stack. The frame
 * contains information about the state of the traversal of that
 * node. For example,
 *
 *   - index of the current child node being visited
 *   - the number of mustaches contained within its child nodes
 *   - the list of actions generated by its child nodes
 */

class Frame {
  public parentNode: Option<Object> = null;
  public children: Option<AST.Node[]> = null;
  public childIndex: Option<number> = null;
  public childCount: Option<number> = null;
  public childTemplateCount = 0;
  public mustacheCount = 0;
  public actions: Action[] = [];
  public blankChildTextNodes: Option<number[]> = null;
  public symbols: Option<SymbolTable> = null;
}

export namespace Action {
  export type StartProgram = ['startProgram', [AST.Program, number, number[]]];
  export type EndProgram = ['endProgram', [AST.Program, number]];
  export type StartBlock = ['startBlock', [AST.Program, number, number[]]];
  export type EndBlock = ['endBlock', [AST.Program, number]];
  export type Block = ['block', [AST.BlockStatement, number, number]];
  export type Mustache = ['mustache', [AST.MustacheStatement | AST.PartialStatement, number, number]];
  export type OpenElement = ['openElement', [AST.ElementNode, number, number, number, number[]]];
  export type CloseElement = ['closeElement', [AST.ElementNode, number, number]];
  export type Text = ['text', [AST.TextNode, number, number]];
  export type Comment = ['comment', [AST.CommentStatement, number, number]];

  export type Action =
      StartProgram
    | EndProgram
    | StartBlock
    | EndBlock
    | Block
    | Mustache
    | OpenElement
    | CloseElement
    | Text
    | Comment
    ;
}

export type Action = Action.Action;

export default class TemplateVisitor {
  private frameStack: Frame[] = [];
  public actions: Action[] = [];
  private programDepth = -1;

  visit(node: AST.BaseNode) {
    this[node.type](node);
  }

  // Traversal methods

  Program(program: AST.Program) {
    this.programDepth++;

    let parentFrame = this.getCurrentFrame();
    let programFrame = this.pushFrame();

    if (!parentFrame) {
      program['symbols'] = SymbolTable.top();
    } else {
      program['symbols'] = parentFrame.symbols!.child(program.blockParams);
    }

    let startType, endType;

    if (this.programDepth === 0) {
      startType = 'startProgram';
      endType = 'endProgram';
    } else {
      startType = 'startBlock';
      endType = 'endBlock';
    }

    programFrame.parentNode = program;
    programFrame.children = program.body;
    programFrame.childCount = program.body.length;
    programFrame.blankChildTextNodes = [];
    programFrame.actions.push([endType, [program, this.programDepth]] as Action);
    programFrame.symbols = program['symbols'];

    for (let i = program.body.length - 1; i >= 0; i--) {
      programFrame.childIndex = i;
      this.visit(program.body[i]);
    }

    programFrame.actions.push([startType, [
      program, programFrame.childTemplateCount,
      programFrame.blankChildTextNodes.reverse()
    ]] as Action);
    this.popFrame();

    this.programDepth--;

    // Push the completed template into the global actions list
    if (parentFrame) { parentFrame.childTemplateCount++; }
    this.actions.push(...programFrame.actions.reverse());
  }

  ElementNode(element: AST.ElementNode) {
    let parentFrame = this.getCurrentFrame();
    let elementFrame = this.pushFrame();

    elementFrame.parentNode = element;
    elementFrame.children = element.children;
    elementFrame.childCount = element.children.length;
    elementFrame.mustacheCount += element.modifiers.length;
    elementFrame.blankChildTextNodes = [];
    elementFrame.symbols = element['symbols'] = parentFrame.symbols!.child(element.blockParams);

    let actionArgs: [AST.ElementNode, number, number] = [
      element,
      parentFrame.childIndex!,
      parentFrame.childCount!
    ];

    elementFrame.actions.push(['closeElement', actionArgs]);

    for (let i = element.attributes.length - 1; i >= 0; i--) {
      this.visit(element.attributes[i]);
    }

    for (let i = element.children.length - 1; i >= 0; i--) {
      elementFrame.childIndex = i;
      this.visit(element.children[i]);
    }

    let open = ['openElement', [...actionArgs, elementFrame.mustacheCount, elementFrame.blankChildTextNodes.reverse()]] as Action.OpenElement;
    elementFrame.actions.push(open);

    this.popFrame();

    // Propagate the element's frame state to the parent frame
    if (elementFrame.mustacheCount > 0) { parentFrame.mustacheCount++; }
    parentFrame.childTemplateCount += elementFrame.childTemplateCount;
    parentFrame.actions.push(...elementFrame.actions);
  }

  AttrNode(attr: AST.AttrNode) {
    if (attr.value.type !== 'TextNode') {
      this.getCurrentFrame().mustacheCount++;
    }
  };

  TextNode(text: AST.TextNode) {
    let frame = this.getCurrentFrame();
    if (text.chars === '') {
      frame.blankChildTextNodes!.push(domIndexOf(frame.children!, text));
    }
    frame.actions.push(['text', [text, frame.childIndex, frame.childCount]] as Action);
  };

  BlockStatement(node: AST.BlockStatement) {
    let frame = this.getCurrentFrame();

    frame.mustacheCount++;
    frame.actions.push(['block', [node, frame.childIndex, frame.childCount]] as Action);

    if (node.inverse) { this.visit(node.inverse); }
    if (node.program) { this.visit(node.program); }
  };

  PartialStatement(node: AST.PartialStatement) {
    let frame = this.getCurrentFrame();
    frame.mustacheCount++;
    frame.actions.push(['mustache', [node, frame.childIndex, frame.childCount]] as Action);
  };

  CommentStatement(text: AST.CommentStatement) {
    let frame = this.getCurrentFrame();
    frame.actions.push(['comment', [text, frame.childIndex, frame.childCount]] as Action);
  };

  MustacheCommentStatement() {
    // Intentional empty: Handlebars comments should not affect output.
  };

  MustacheStatement(mustache: AST.MustacheStatement) {
    let frame = this.getCurrentFrame();
    frame.mustacheCount++;
    frame.actions.push(['mustache', [mustache, frame.childIndex, frame.childCount]] as Action);
  };

  // Frame helpers

  private getCurrentFrame(): Frame {
    return expect(this.frameStack[this.frameStack.length - 1], "Expected a current frame");
  }

  private pushFrame() {
    let frame = new Frame();
    this.frameStack.push(frame);
    return frame;
  }

  private popFrame() {
    return this.frameStack.pop();
  }
}

// Returns the index of `domNode` in the `nodes` array, skipping
// over any nodes which do not represent DOM nodes.
function domIndexOf(nodes: AST.Node[], domNode: AST.TextNode | AST.ElementNode) {
  let index = -1;

  for (let i = 0; i < nodes.length; i++) {
    let node = nodes[i];

    if (node.type !== 'TextNode' && node.type !== 'ElementNode') {
      continue;
    } else {
      index++;
    }

    if (node === domNode) {
      return index;
    }
  }

  return -1;
}
