import { MessageVault, SpyMerkleWitness } from './message-vault';
import { 
  Field,
  Mina,
  PublicKey,
  PrivateKey,
  AccountUpdate,
  MerkleTree,
  MerkleMap,
  MerkleMapWitness,
} from 'o1js';

const proofsEnabled = false;

describe('msg-vault.js', () => {
  let deployerAccount: PublicKey,
  deployerKey: PrivateKey,
  senderAccount: PublicKey,
  senderKey: PrivateKey, 
  zkappAddress: PublicKey,
  zkappPrivateKey: PrivateKey,
  zkapp: MessageVault;

  beforeAll(async () => {
    if (proofsEnabled) await MessageVault.compile();
  });

  beforeEach(() => {
    const Local = Mina.LocalBlockchain({ proofsEnabled });
    Mina.setActiveInstance(Local);
    ({ privateKey: deployerKey, publicKey: deployerAccount } =
      Local.testAccounts[0]);
    ({ privateKey: senderKey, publicKey: senderAccount } =
      Local.testAccounts[1]);
    zkappPrivateKey = PrivateKey.random();
    zkappAddress = zkappPrivateKey.toPublicKey();
    zkapp = new MessageVault(zkappAddress);
  });

  async function localDeploy() { 
    const txn = await Mina.transaction(deployerAccount, () => {
      AccountUpdate.fundNewAccount(deployerAccount);
      zkapp.deploy();
    });
    await txn.prove();
    await txn.sign([deployerKey, zkappPrivateKey]).send();
  }

  it('Generate and Deploy `MessageVault` smart contract', async () => {
    await localDeploy();

    // deployer initializes zkapp
    const initTxn = await Mina.transaction(deployerAccount, () => {
      zkapp.initVault();
    });
    await initTxn.prove();
    await initTxn.sign([deployerKey]).send();

    const storageCounter = zkapp.spyCount.get();

    expect(storageCounter).toEqual(Field(-1));
  })

  describe.skip('Message Vault: Address Storage', () => {
    async function storeSpyAddress() { 
      let index = zkapp.spyCount.get().add(1);
      let w = spyTree.getWitness(index.toBigInt());
      let randomSpyWitness = new SpyMerkleWitness(w);

      let randomSpyAddress = PrivateKey.random().toPublicKey();
      // storage transaction
      // retrieve and update off-chain merkle tree
      let storeTxn = await Mina.transaction(deployerAccount, () => {
        zkapp.storeAddress(randomSpyAddress, randomSpyWitness);
      });
      
      await storeTxn.prove();
      await storeTxn.sign([deployerKey]).send();

      // update off-chain tree
      let spyAddress = zkapp.spyAddress.get()
      spyTree.setLeaf(index.toBigInt(), spyAddress); 
      
      // update local index map
      spyIndexMap.addAddress(spyAddress, Number(index.toBigInt()))
    }

    it('should store 100 random addresses successfully', async () => {
      await localDeploy();
      // deployer initializes zkapp
      const initTxn = await Mina.transaction(deployerAccount, () => {
        zkapp.initVault();
      });
      await initTxn.prove();
      await initTxn.sign([deployerKey]).send();
      
      for(let i=0; i<100; i++) await storeSpyAddress();      
    });
    it.todo('should reject non-compliant index');
    it.todo('should reject non-updated off-chain address merkle tree');
    it.todo('should reject storing more than 100 addresses');
  });
});


// initialize a new MerkleTree with height 8 ==> size=256 > 100
const spyTree = new MerkleTree(8);

// console.log('initial commitment: ', initialCommitment.toBigInt());
//TODO when tree not initialized check commitiment


class AddressIndexMap<T> {
  private valueToIndexMap: Map<T, number>;
  private indexToValueArray: T[];

  constructor() {
      this.valueToIndexMap = new Map<T, number>();
      this.indexToValueArray = [];
  }

  // Add an address to the map with an optional index
  addAddress(value: T, index?: number): void {
    if (index !== undefined) {
        // If index is provided, use it
        if (index < 0 || index > this.indexToValueArray.length) {
            throw new Error(`Invalid index: ${index}`);
        }
        if (this.indexToValueArray[index] !== undefined) {
            throw new Error(`Index ${index} is already occupied.`);
        }
    } else {
        // If index is not provided, assign a new index
        index = this.indexToValueArray.length;
    }

    this.valueToIndexMap.set(value, index);
    this.indexToValueArray[index] = value;
}

  // Get the index of a value
  getIndex(value: T): number | undefined {
      return this.valueToIndexMap.get(value);
  }

  // Get the value at a specific index
  getAddressAtIndex(index: number): T | undefined {
      return this.indexToValueArray[index];
  }
}

const spyIndexMap: AddressIndexMap<Field> = new AddressIndexMap();

const map = new MerkleMap();
console.log('empty map root: ', map.getRoot().toBigInt())
