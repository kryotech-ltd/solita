import {
  IdlInstruction,
  IdlInstructionArg,
  SOLANA_WEB3_EXPORT_NAME,
  IdlInstructionAccount,
  SOLANA_SPL_TOKEN_PACKAGE,
  SOLANA_SPL_TOKEN_EXPORT_NAME,
  TypeMappedSerdeField,
  SOLANA_WEB3_PACKAGE,
  isIdlInstructionAccountWithDesc,
} from './types'
import { ForceFixable, TypeMapper } from './type-mapper'
import { renderDataStruct } from './serdes'
import {
  renderKnownPubkeyAccess,
  ResolvedKnownPubkey,
  resolveKnownPubkey,
} from './known-pubkeys'
import { BEET_PACKAGE } from '@metaplex-foundation/beet'
import { renderScalarEnums } from './render-enums'
import { InstructionDiscriminator } from './instruction-discriminator'

type ProcessedAccountKey = IdlInstructionAccount & {
  knownPubkey?: ResolvedKnownPubkey
}

class InstructionRenderer {
  readonly upperCamelIxName: string
  readonly camelIxName: string
  readonly argsTypename: string
  readonly accountsTypename: string
  readonly instructionDiscriminatorName: string
  readonly structArgName: string
  private readonly instructionDiscriminator: InstructionDiscriminator

  constructor(
    readonly ix: IdlInstruction,
    readonly programId: string,
    private readonly typeMapper: TypeMapper
  ) {
    this.upperCamelIxName = ix.name
      .charAt(0)
      .toUpperCase()
      .concat(ix.name.slice(1))

    this.camelIxName = ix.name.charAt(0).toLowerCase().concat(ix.name.slice(1))

    this.argsTypename = `${this.upperCamelIxName}InstructionArgs`
    this.accountsTypename = `${this.upperCamelIxName}InstructionAccounts`
    this.instructionDiscriminatorName = `${this.camelIxName}InstructionDiscriminator`
    this.structArgName = `${ix.name}Struct`

    this.instructionDiscriminator = new InstructionDiscriminator(
      ix,
      'instructionDiscriminator',
      typeMapper
    )
  }

  // -----------------
  // Instruction Args Type
  // -----------------
  private renderIxArgField = (arg: IdlInstructionArg) => {
    const typescriptType = this.typeMapper.map(arg.type, arg.name)
    return `${arg.name}: ${typescriptType}`
  }

  private renderIxArgsType() {
    if (this.ix.args.length === 0) return ''
    const fields = this.ix.args
      .map((field) => this.renderIxArgField(field))
      .join(',\n  ')

    const code = `export type ${this.argsTypename} = {
  ${fields}
}`
    return code
  }

  // -----------------
  // Imports
  // -----------------
  private renderImports(processedKeys: ProcessedAccountKey[]) {
    const typeMapperImports = this.typeMapper.importsForSerdePackagesUsed(
      new Set([SOLANA_WEB3_PACKAGE, BEET_PACKAGE])
    )
    const needsSplToken = processedKeys.some(
      (x) => x.knownPubkey?.pack === SOLANA_SPL_TOKEN_PACKAGE
    )
    const splToken = needsSplToken
      ? `\nimport * as ${SOLANA_SPL_TOKEN_EXPORT_NAME} from '${SOLANA_SPL_TOKEN_PACKAGE}';`
      : ''

    return `
${splToken}
${typeMapperImports.join('\n')}`.trim()
  }

  // -----------------
  // Accounts
  // -----------------
  private processIxAccounts(): ProcessedAccountKey[] {
    return this.ix.accounts.map((acc) => {
      const knownPubkey = resolveKnownPubkey(acc.name)
      return knownPubkey == null ? acc : { ...acc, knownPubkey }
    })
  }

  private renderIxAccountKeys(processedKeys: ProcessedAccountKey[]) {
    const keys = processedKeys
      .map(({ name, isMut, isSigner, knownPubkey }) => {
        const access =
          knownPubkey == null ? name : renderKnownPubkeyAccess(knownPubkey)
        return `{
      pubkey: ${access},
      isWritable: ${isMut.toString()},
      isSigner: ${isSigner.toString()},
    }`
      })
      .join(',\n    ')
    return `[\n    ${keys}\n  ]\n`
  }

  private renderAccountsType(processedKeys: ProcessedAccountKey[]) {
    const web3 = SOLANA_WEB3_EXPORT_NAME
    const fields = processedKeys
      .filter((x) => x.knownPubkey == null)
      .map((x) => `${x.name}: ${web3}.PublicKey`)
      .join('\n  ')

    const propertyComments = processedKeys
      .filter(isIdlInstructionAccountWithDesc)
      .map((x) => ` * @property ${x.name} ${x.desc}`)

    const properties =
      propertyComments.length > 0
        ? `\n *\n  ${propertyComments.join('\n')}`
        : ''

    const docs = `
/**
  * Accounts required by the _${this.ix.name}_ instruction${properties}
  */
`.trim()
    return `${docs}
export type ${this.accountsTypename} = {
  ${fields}
}
`
  }

  private renderAccountsDestructure(processedKeys: ProcessedAccountKey[]) {
    const params = processedKeys
      .filter((x) => x.knownPubkey == null)
      .map((x) => `${x.name}`)
      .join(',\n    ')
    return `const {
    ${params}
  } = accounts;
`
  }

  // -----------------
  // Data Struct
  // -----------------
  private serdeProcess() {
    return this.typeMapper.mapSerdeFields(this.ix.args)
  }

  private renderDataStruct(args: TypeMappedSerdeField[]) {
    const discriminatorField = this.typeMapper.mapSerdeField(
      this.instructionDiscriminator.getField()
    )
    const discriminatorType = this.instructionDiscriminator.renderType()
    return renderDataStruct({
      fields: args,
      discriminatorName: 'instructionDiscriminator',
      discriminatorField,
      discriminatorType,
      structVarName: this.structArgName,
      argsTypename: this.argsTypename,
      isFixable: this.typeMapper.usedFixableSerde,
    })
  }

  render() {
    this.typeMapper.clearUsages()

    const ixArgType = this.renderIxArgsType()
    const processedKeys = this.processIxAccounts()
    const accountsType = this.renderAccountsType(processedKeys)

    const processedArgs = this.serdeProcess()
    const argsStructType = this.renderDataStruct(processedArgs)

    const keys = this.renderIxAccountKeys(processedKeys)
    const accountsDestructure = this.renderAccountsDestructure(processedKeys)
    const instructionDisc = this.instructionDiscriminator.renderValue()
    const enums = renderScalarEnums(this.typeMapper.scalarEnumsUsed).join('\n')

    const web3 = SOLANA_WEB3_EXPORT_NAME
    const imports = this.renderImports(processedKeys)

    const [
      createInstructionArgsComment,
      createInstructionArgs,
      createInstructionArgsSpread,
    ] =
      this.ix.args.length === 0
        ? ['', '', '']
        : [
            `\n * @param args to provide as instruction data to the program`,
            `args: ${this.argsTypename}`,
            '...args',
          ]
    return `${imports}

${enums}
${ixArgType}
${argsStructType}
${accountsType}
const ${this.instructionDiscriminatorName} = ${instructionDisc};

/**
 * Creates a _${this.upperCamelIxName}_ instruction.
 * 
 * @param accounts that will be accessed while the instruction is processed${createInstructionArgsComment}
 */
export function create${this.upperCamelIxName}Instruction(
  accounts: ${this.accountsTypename},
  ${createInstructionArgs}
) {
  ${accountsDestructure}
  const [data ] = ${this.structArgName}.serialize({ 
    instructionDiscriminator: ${this.instructionDiscriminatorName},
    ${createInstructionArgsSpread}
  });
  const keys: ${web3}.AccountMeta[] = ${keys}
  const ix = new ${web3}.TransactionInstruction({
    programId: new ${web3}.PublicKey('${this.programId}'),
    keys,
    data
  });
  return ix; 
}
`
  }
}

export function renderInstruction(
  ix: IdlInstruction,
  programId: string,
  forceFixable: ForceFixable,
  userDefinedEnums: Set<string>
) {
  const typeMapper = new TypeMapper(forceFixable, userDefinedEnums)
  const renderer = new InstructionRenderer(ix, programId, typeMapper)
  return renderer.render()
}
