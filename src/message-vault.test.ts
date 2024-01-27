import { MessageVault, SpyMerkleWitness } from './message-vault';
import { 
  Field,
  Mina,
  PublicKey,
  PrivateKey,
  AccountUpdate,
  MerkleTree,
} from 'o1js';

const proofsEnabled = false;

describe('msg-vault.js', () => {
  let deployerAccount: PublicKey,
  deployerKey: PrivateKey,
  senderAccount: PublicKey,
  senderKey: PrivateKey, 
  zkappAddress: PublicKey,
  zkappPrivateKey: PrivateKey,
  zkapp: MessageVault,
  addressTree: MerkleTree,
  addressIndexMap: AddressIndexMap<Field>;

  beforeAll(async () => {
    if (proofsEnabled) await MessageVault.compile();

    const Local = Mina.LocalBlockchain({ proofsEnabled });
    Mina.setActiveInstance(Local);
    ({ privateKey: deployerKey, publicKey: deployerAccount } =
      Local.testAccounts[0]);
    ({ privateKey: senderKey, publicKey: senderAccount } =
      Local.testAccounts[1]);
    zkappPrivateKey = PrivateKey.random();
    zkappAddress = zkappPrivateKey.toPublicKey();
    zkapp = new MessageVault(zkappAddress);

    // initialize local address Merkle Tree
    addressTree = new MerkleTree(8);

    // initialize local address-index map
    addressIndexMap = new AddressIndexMap();
  });

  async function localDeploy() { 
    const txn = await Mina.transaction(deployerAccount, () => {
      AccountUpdate.fundNewAccount(deployerAccount);
      zkapp.deploy();
    });
    await txn.prove();
    await txn.sign([deployerKey, zkappPrivateKey]).send();
  }

  async function initializeVault() {
    // deployer initializes zkapp
    const initTxn = await Mina.transaction(deployerAccount, () => {
      zkapp.initVault();
    });
    await initTxn.prove();
    await initTxn.sign([deployerKey]).send();
  }

  describe('Message Vault: Negative Address Storage', () => {
    it('Generate and Deploy `MessageVault` smart contract', async () => {
      await localDeploy();
      await initializeVault();

      const storageCounter = zkapp.spyCount.get();

      expect(storageCounter).toEqual(Field(-1));
    })
  });

  describe('Message Vault: Address Storage', () => {
    async function storeSpyAddress(senderKey=deployerKey, falseIndex?: Field, updateLocal=true) { 
      let index = falseIndex ?? zkapp.spyCount.get().add(1);
      let w = addressTree.getWitness(index.toBigInt());
      let randomSpyWitness = new SpyMerkleWitness(w);

      let randomSpyAddress = PrivateKey.random().toPublicKey();
      // storage transaction
      // retrieve and update off-chain merkle tree
      let storeTxn = await Mina.transaction(senderKey.toPublicKey(), () => {
        zkapp.storeAddress(randomSpyAddress, randomSpyWitness);
      });
      
      await storeTxn.prove();
      await storeTxn.sign([senderKey]).send();

      if (updateLocal) { 
        // update off-chain address tree
        let spyAddress = zkapp.spyAddress.get()
        addressTree.setLeaf(index.toBigInt(), spyAddress); 
        
        // update local address-index map
        addressIndexMap.addAddress(spyAddress, Number(index.toBigInt()));
      }
    }

    it('should reject any sender except admin to store an address', async () => {
      await expect(storeSpyAddress(senderKey)).rejects.toThrowError('Only Admin is allowed to call this method!');
    });

    it('should reject non-compliant storage index', async () => {
      await expect(storeSpyAddress(deployerKey, Field(10))).rejects.toThrowError('Off-chain storage index is not compliant!');
    });

    it('should successfully store one random address', async () => { 
      await storeSpyAddress();
    });

    it('should reject non-updated off-chain address merkle tree', async () => {
      await storeSpyAddress(deployerKey, undefined, false);
      await expect(storeSpyAddress()).rejects.toThrowError('Off-chain address merkle tree is out of sync!');
    });

    it('should successfully store address till cap=100 is reached', async () => {
      // update address local storage following the skipped update in the previous test-case
      const index = zkapp.spyCount.get();
      
      // update off-chain address tree
      const spyAddress = zkapp.spyAddress.get()
      addressTree.setLeaf(index.toBigInt(), spyAddress); 
      
      // update local address-index map
      addressIndexMap.addAddress(spyAddress, Number(index.toBigInt()));

      for(let i=0; i<98; i++) await storeSpyAddress();      
    });

    it('should reject storing more than 100 addresses', async () => {
      await expect(storeSpyAddress()).rejects.toThrowError('Reached maximum storage cap of 100 addresses!')
    });
  });
});

//TODO add test coverage for message storage 

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