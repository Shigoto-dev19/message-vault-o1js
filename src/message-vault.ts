import { 
    State,
    state,
    method,
    PublicKey,
    Field,
    SmartContract,
    Poseidon,
    MerkleWitness,
    Provable,
    Bool,
} from 'o1js';

export {
    MessageVault,
    SpyMerkleWitness,
    MessageMerkleWitness,
}

class SpyMerkleWitness extends MerkleWitness(8) {}
class MessageMerkleWitness extends MerkleWitness(8) {}

class MessageVault extends SmartContract {
    @state(Field) adminAddress = State<Field>();

    @state(Field) addressCommitment = State<Field>();
    @state(Field) spyAddress = State<Field>();
    @state(Field) spyCount = State<Field>();
    
    @state(Field) messageCommitment = State<Field>();
    @state(Field) message = State<Field>();
    @state(Field) messageCount = State<Field>();

    events = {
        "Successfully received a valid message": Field,
    }

    @method initVault() {
        super.init();

        // the admin is set as the zkapp initializer
        this.adminAddress.set(Poseidon.hash(this.sender.toFields()));

        // set address commitment as the root of an empty Merkle Tree of size 256
        this.addressCommitment.set(Field(14472842460125086645444909368571209079194991627904749620726822601198914470820n));

        this.spyCount.set(Field(-1));
        this.spyAddress.set(Field(0));

        // set message commitment as the root of an empty Merkle Tree of size 256
        this.messageCommitment.set(Field(14472842460125086645444909368571209079194991627904749620726822601198914470820n));
        this.message.set(Field(0));
        this.messageCount.set(Field(0));
    }

    /**
     * We take a witness with index the same as the storage count
     * @param spy 
     * @param spyWitness 
     */
    @method storeAddress(spyAddress: PublicKey, addressWitness: SpyMerkleWitness) {
        // assert that only the admin is allowed to store addresses
        const senderAddressDigest = Poseidon.hash(this.sender.toFields());
        this.adminAddress.getAndRequireEquals().assertEquals(senderAddressDigest, 'Only Admin is allowed to call this method!');

        // fetch on-chain address counter and add 1
        let incrementedCount = this.spyCount.getAndRequireEquals().add(1);

        // make sure not to store more than 100 addresses
        incrementedCount.assertLessThan(100, 'Reached maximum storage cap of 100 addresses!');
        
        // make sure storage index is in sync with the on-chain spy address counter
        let storageIndex = addressWitness.calculateIndex();
        storageIndex.assertEquals(incrementedCount, 'Off-chain storage index is not compliant!');

        /* 
        1. check that the address leaf is empty 
            --> prevent updating an already stored address
        2. check that the off-chain address storage is in sync
            --> a witness of an empty leaf(before update) maintains the same root(commitiment)
        */ 
        let currentCommitment = addressWitness.calculateRoot(Field(0));
        this.addressCommitment.getAndRequireEquals().assertEquals(currentCommitment, 'Off-chain address merkle tree is out of sync!');

        // hash the address taking advantage of field conversion + masking property
        let addressDigest = Poseidon.hash(spyAddress.toFields());

        // update on-chain spy address
        this.spyAddress.set(addressDigest);
    
        // calculate the new merkle root following the updated address storage
        let updatedCommitment = addressWitness.calculateRoot(addressDigest);

        // update the on-chain address Merkle Tree commitment(root)
        this.addressCommitment.set(updatedCommitment);

        // increment the on-chain count
        this.spyCount.set(incrementedCount);
    }   

    @method checkAndStoreMessage(addressWitness: SpyMerkleWitness, message: Field, messageWitness: MessageMerkleWitness) { 
        // hash the sender address
        let senderAddressDigest = Poseidon.hash(this.sender.toFields());

        /* 
        1. check that the sender is eligible to store a message
        2. also checks that spy address off-chain storage is in sync
        3. using the spyAddress from the address Merkle tree verifies compliance with message Merkle Tree 
            --> this also binds messages to the size=100 storage limit.
        */
        let spyCommitment = addressWitness.calculateRoot(senderAddressDigest);
        spyCommitment.assertEquals(this.addressCommitment.getAndRequireEquals());
        
        // calculate the index where the eligible address is stored
        let addressIndex = addressWitness.calculateIndex();

        // calculate the index where the message is to be stored
        let messageIndex = messageWitness.calculateIndex();

        /* 
        - assert that the index of the message to be store is the same as the index of the sender address
            --> this ensures compliant binding of address to message following the same index
         */
        messageIndex.assertEquals(addressIndex);

        /* 
        1. check that the message leaf is empty 
            --> ensures that one address can only deposit one message
        2. check that the off-chain message storage is in sync
            --> a witness of an empty leaf(before update) maintains the same root(commitiment)
        */ 
        let currentMessageCommitment = messageWitness.calculateRoot(Field(0));
        this.messageCommitment.getAndRequireEquals().assertEquals(currentMessageCommitment);
        
        // validate message flags
        validateMessage(message); 

        // calculate the new merkle root following the updated message storage
        let updatedMessageCommitment = messageWitness.calculateRoot(message);

        // update the on-chain message Merkle Tree commitment(root)
        this.messageCommitment.set(updatedMessageCommitment);

        // update the stored on-chain message and message count
        this.message.set(message);

        // fetch and increment current message count
        const updatedMessageCount = this.messageCount.getAndRequireEquals().add(1);
        
        /* 
        - the message count is binded to the address storage count.
        - this an supplementary assertion on the message storage size limit
        - this assertion might never fail because the addressCommitment check will revert first. 
        */
        updatedMessageCount.assertLessThanOrEqual(100, 'Reached maximum storage cap of 100 addresses!');
        
        // set updated on-chain message count
        this.messageCount.set(updatedMessageCount);

        // emit event for receiving a valid message
        this.emitEvent("Successfully received a valid message", this.messageCount.getAndRequireEquals());
    }
}

//TODO Bind address tree to the message merkle map

function validateMessage(message: Field) {
    // Use a bitmask to extract the last six digits
    const slicedMessage = Provable.witness(Provable.Array(Field, 2), () => {
        let divMillion = Field(message.toBigInt() / 1_000_000n);
        let modMillion = Field(message.toBigInt() % 1_000_000n);
        return [divMillion, modMillion]
    });
    
    const [restDigits, lastSixDigits] = slicedMessage;

    // assert the integrity of the slicing operation
    restDigits.mul(1_000_000).add(lastSixDigits).assertEquals(message);

    // check that all digits are of size 1 bit
    lastSixDigits.assertLessThanOrEqual(111111, 'Error Validating Message! All flags are not of size 1 bit!');
    
    const flags = Provable.witness(Provable.Array(Bool, 6), () => {
        let digits = lastSixDigits.toBigInt();
        let flags: bigint[] = [];
        
        for (let i=0; i<6; i++) {
            flags.push(digits % 10n);
            digits = digits / 10n; 
        }

        return flags.map((d) => d === 1n ? Bool(true) : Bool(false));
    });

    let flagsChecker = Field(0);
    for (const [index, flag] of flags.entries()) { 
        flagsChecker = flagsChecker.add(flag.toField().mul(10 ** index))
    }

    // check integrity of converting the six digit filed into an array of 6 flags
    flagsChecker.assertEquals(lastSixDigits, 'Error Separating Message Flags!');
    
    const [flag1, flag2, flag3, flag4, flag5, flag6] = flags;
    
    // if flag 1 is true, then all other flags must be false
    const rule1 = flag1.and(lastSixDigits.equals(100_000).not());
    rule1.assertFalse('Invalid Message! Rule1 is violated!');
    
    // if flag 2 is true, then flag 3 must also be true.
    const rule2 = flag2.and(flag3.not());
    rule2.assertFalse('Invalid Message! Rule2 is violated!');

    // if flag 4 is true, then flags 5 and 6 must be false.
    const rule3 = flag4.and(flag5.or(flag6));
    rule3.assertFalse('Invalid Message! Rule3 is violated!');
}

// import { Gadgets } from 'o1js';
// const randomMessage = Field(1234234324234234340100100n)//Field.random();
// console.log('random message: ', randomMessage.toBigInt());
// const messageBits = randomMessage.toBits();

// console.log('using function: ', validateMessage(randomMessage))