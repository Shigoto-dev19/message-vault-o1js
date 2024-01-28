/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { 
  MessageVault, 
  SpyMerkleWitness,
  MessageMerkleWitness,
} from './message-vault';
import { 
  Field,
  Mina,
  PublicKey,
  PrivateKey,
  AccountUpdate,
  MerkleTree,
  Poseidon,
} from 'o1js';

const proofsEnabled = false;

describe.only('msg-vault.js', () => {
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
    
    it('Generate and Deploy `MessageVault` smart contract', async () => {
      await localDeploy();
      await initializeVault();

      const storageCounter = zkapp.spyCount.get();

      expect(storageCounter).toEqual(Field(-1));
    });

    it('should reject tx for any sender except admin to store an address', async () => {
      await expect(storeSpyAddress(senderKey)).rejects.toThrowError('Only Admin is allowed to call this method!');
    });

    it('should reject tx for non-compliant storage index', async () => {
      await expect(storeSpyAddress(deployerKey, Field(10))).rejects.toThrowError('Off-chain storage index is not compliant!');
    });

    it('should successfully store one random address', async () => { 
      await storeSpyAddress();
    });

    it('should reject tx for non-updated off-chain address merkle tree', async () => {
      await storeSpyAddress(deployerKey, undefined, false);
      await expect(storeSpyAddress()).rejects.toThrowError('Off-chain address merkle tree is out of sync!');

      // update address local storage following the skipped update to keep integrity for the next test cases
      const index = zkapp.spyCount.get();
      
      // update off-chain address tree
      const spyAddress = zkapp.spyAddress.get()
      addressTree.setLeaf(index.toBigInt(), spyAddress); 
      
      // update local address-index map
      addressIndexMap.addAddress(spyAddress, Number(index.toBigInt()));
    });

    it('should reject tx for a tampered off-chain address merkle tree: fill empty leaf', async () => {
      // fetch an index for an empty leaf
      let leafIndex = zkapp.spyCount.get().add(2);

      // random impostor address
      const impostorAddress = Field.random();
      
      // tamper with local address Merkle Tree
      addressTree.setLeaf(leafIndex.toBigInt(), impostorAddress);
      
      await expect(storeSpyAddress()).rejects.toThrowError('Off-chain address merkle tree is out of sync!');

      // fix local merkle tree to keep integrity for the next test-case
      addressTree.setLeaf(leafIndex.toBigInt(), Field(0));
    });

    it('should reject tx for a tampered off-chain address merkle tree: alter full leaf', async () => {
      // fetch an index for an already full leaf 
      // --> in this case, the first leaf
      let fullIndex = 0n;

      // keep the right address to fix the leaf later 
      let correctLeaf = addressTree.getNode(0, fullIndex);

      // random impostor address
      const impostorAddress = Field.random();
      
      // tamper with local address Merkle Tree
      addressTree.setLeaf(fullIndex, impostorAddress);
      
      await expect(storeSpyAddress()).rejects.toThrowError('Off-chain address merkle tree is out of sync!');

      // fix local merkle tree to keep integrity for the next test-case
      addressTree.setLeaf(fullIndex, correctLeaf);
    });

    it('should successfully store address till cap=100 is reached', async () => {
      for(let i=0; i<98; i++) await storeSpyAddress();      
    });

    it('should reject storing more than 100 addresses', async () => {
      await expect(storeSpyAddress()).rejects.toThrowError('Reached maximum storage cap of 100 addresses!')
    });
  });
});

describe('msg-vault.js MESSENGER', () => {
  let deployerAccount: PublicKey,
  deployerKey: PrivateKey,
  payerAccount: PublicKey,
  payerKey: PrivateKey, 
  zkappAddress: PublicKey,
  zkappPrivateKey: PrivateKey,
  zkapp: MessageVault,
  addressTree: MerkleTree,
  addressIndexMap: AddressIndexMap<PrivateKey>,
  messageTree: MerkleTree;

  beforeAll(async () => {
    if (proofsEnabled) await MessageVault.compile();

    const Local = Mina.LocalBlockchain({ proofsEnabled });
    Mina.setActiveInstance(Local);
    ({ privateKey: deployerKey, publicKey: deployerAccount } =
      Local.testAccounts[0]);
    ({ privateKey: payerKey, publicKey: payerAccount } =
      Local.testAccounts[1]);
    zkappPrivateKey = PrivateKey.random();
    zkappAddress = zkappPrivateKey.toPublicKey();
    zkapp = new MessageVault(zkappAddress);

    // initialize local address Merkle Tree
    addressTree = new MerkleTree(8);

    // initialize local address-index map
    addressIndexMap = new AddressIndexMap();

    // initialize local message Merkle Tree
    messageTree = new MerkleTree(8);
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

  describe('Message Vault: Message Storage', () => {
    async function storeSpyAddress(spyKey?: PrivateKey) { 
      let index = zkapp.spyCount.get().add(1);
      let w = addressTree.getWitness(index.toBigInt());
      let randomSpyWitness = new SpyMerkleWitness(w);

      let randomSpyKey = spyKey ?? PrivateKey.random();
      let randomSpyAddress = randomSpyKey.toPublicKey();
      // storage transaction
      // retrieve and update off-chain merkle tree
      let storeTxn = await Mina.transaction(deployerKey.toPublicKey(), () => {
        zkapp.storeAddress(randomSpyAddress, randomSpyWitness);
      });
      
      await storeTxn.prove();
      await storeTxn.sign([deployerKey]).send();

      // update off-chain address Merkle Tree
      let spyAddress = zkapp.spyAddress.get()
      addressTree.setLeaf(index.toBigInt(), spyAddress); 
      
      // update local address-index map
      addressIndexMap.addAddress(randomSpyKey, Number(index.toBigInt()));
    }
    
    async function fundAccount(accountAddress: PublicKey) {
      let tx = await Mina.transaction(payerAccount, () => {
        let senderUpdate = AccountUpdate.fundNewAccount(payerAccount);
        senderUpdate.send({ to: accountAddress, amount: 1_100_000_000 });
      });
    
      await tx.prove();
      await tx.sign([payerKey]).send();
    }

    async function storeMessage(senderKey: PrivateKey, falseMessageIndex?: number, updateLocal=true) {    
      // hash sender address & fetch its corresponding index from the local address-index map
      let senderIndex = addressIndexMap.getIndex(senderKey)!;
      
      let w1 = addressTree.getWitness(BigInt(senderIndex));
      let addressWitness = new SpyMerkleWitness(w1);
      
      let senderAddress = senderKey.toPublicKey();

      let w2 = messageTree.getWitness(BigInt(falseMessageIndex ?? senderIndex));
      let messageWitness = new MessageMerkleWitness(w2);

      let message = Field(123423432423423434100000n);
      
      let messageTxn = await Mina.transaction(senderAddress, () => {
        zkapp.checkAndStoreMessage(addressWitness, message, messageWitness);
      });

      await messageTxn.prove();
      await messageTxn.sign([senderKey]).send();

      if (updateLocal) { 
        // update off-chain message Merkle Tree
        messageTree.setLeaf(BigInt(senderIndex), message);
      }
    }

    it('should successfully store 30 random addresses ', async () => {
      await localDeploy();
      await initializeVault();

      for(let i=0; i<30; i++) await storeSpyAddress();      
    });

    it('should successfully store one message from one random eligible address', async () => {
      let randomStoredAddress = addressIndexMap.getRandomAddress()!;
      
      // fund account to pay for the transaction fees
      await fundAccount(randomStoredAddress.toPublicKey());
      
      await storeMessage(randomStoredAddress);
    });

    it('should successfully store messages from 20 eligible address', async () => {
        let randomStoredAddress: PrivateKey;
         
      for (let i=0; i<20; i++) {
        randomStoredAddress = addressIndexMap.getRandomAddress()!;
        await fundAccount(randomStoredAddress.toPublicKey());
        await storeMessage(randomStoredAddress);
      }
      
      const messageCount = zkapp.messageCount.get();
      expect(messageCount).toEqual(Field(21));
    });

    it('should reject non-eligibile address to send a message', async () => {
      let impostorKey = PrivateKey.random();
      
      // tamper with local address merkle tree storage
      addressTree.setLeaf(101n, Poseidon.hash(impostorKey.toPublicKey().toFields()));
      
      // tamper with local address-index map 
      addressIndexMap.addAddress(impostorKey);

      // fund impostor account to pay for the tx fees
      await fundAccount(impostorKey.toPublicKey());

      await expect(storeMessage(impostorKey)).rejects.toThrowError('Your account is not eligible to send a message!');
      
      /*
      fix changes because tampering with the actual local merkle tree 
      will completely change the merkle root and hence the tree will be 
      no longer valid for further test-cases 
      */
      addressTree.setLeaf(101n, Field(0));
      addressIndexMap.emptyIndex(impostorKey);
    });

    // this test verifies compliant binding of address Merkle Tree and message Merkle Tree
    it('should reject tx for non-compliant addressTree and messageTree leaf index', async () => {
      let randomStoredAddress = addressIndexMap.getRandomAddress()!;
      await fundAccount(randomStoredAddress.toPublicKey());
      
      await expect(storeMessage(randomStoredAddress, 101)).rejects.toThrowError('Both addressWitness and messageWitness should point to the same leaf index!');
    });

    it('should reject tx for an eligible address that already sent a message', async () => {
      // in this case, the deployer(admin) is an eligible address
      await storeSpyAddress(deployerKey);

      // no need to fund the deployer account because it is a pre-funded test account
      await storeMessage(deployerKey);
      
      /* 
      - the address has already stored a message so it should revert.
      - verifies that one address is only allowed to send a message once.
       */
      const expectedError = 'Non-compliant Messge Tree Root! Leaf message is already full or off-chain message Merkle Tree is out of sync!';
      await expect(storeMessage(deployerKey)).rejects.toThrowError(expectedError);
    });

    it('should reject tx for non-updated off-chain message merkle tree', async () => {
      let randomStoredAddress1 = addressIndexMap.getRandomAddress()!;
      await fundAccount(randomStoredAddress1.toPublicKey());
      // storeemessage without updating local message Merkle Tree
      await storeMessage(randomStoredAddress1, undefined, false);

      let randomStoredAddress2 = addressIndexMap.getRandomAddress()!;
      await fundAccount(randomStoredAddress2.toPublicKey());
      
      const expectedError = 'Non-compliant Messge Tree Root! Leaf message is already full or off-chain message Merkle Tree is out of sync!';
      await expect(storeMessage(randomStoredAddress2)).rejects.toThrowError(expectedError);
    });
  });
});

//TODO wrap fund inside storeMessage function 
//TODO add test coverage for message flag validation 
//TODO fix the notation of the addressIndexMap to keyIndexMap/accountKeyIndexMap

class AddressIndexMap<T> {
  private valueToIndexMap: Map<T, number>;
  private indexToValueArray: T[];
  private fetchedIndices: Set<number>;

  constructor() {
      this.valueToIndexMap = new Map<T, number>();
      this.indexToValueArray = [];
      this.fetchedIndices = new Set<number>();
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

  // Get a random value from the map that wasn't fetched before
  getRandomAddress(): T | undefined {
    const remainingIndices = this.indexToValueArray
        .map((_, index) => index)
        .filter(index => !this.fetchedIndices.has(index));

    if (remainingIndices.length === 0) {
        return undefined; // Return undefined if all values have been fetched
    }

    const randomIndex = remainingIndices[Math.floor(Math.random() * remainingIndices.length)];
    this.fetchedIndices.add(randomIndex);

    return this.indexToValueArray[randomIndex];
}

  // Empty an index for a given value
  emptyIndex(value: T): void {
    const index = this.valueToIndexMap.get(value);

    if (index !== undefined) {
        // Use type assertion here to allow assigning undefined to the array
        this.indexToValueArray[index] = undefined as T;
        this.valueToIndexMap.delete(value);
    }
  }
}