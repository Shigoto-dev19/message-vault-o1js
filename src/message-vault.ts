import { 
    State,
    state,
    method,
    PublicKey,
    Field,
    SmartContract,
    Poseidon,
    MerkleWitness,
    MerkleMapWitness,
} from 'o1js';

export {
    MessageVault,
    SpyMerkleWitness,
}
class SpyMerkleWitness extends MerkleWitness(8) {}

class MessageVault extends SmartContract {
    @state(Field) commitment = State<Field>();
    @state(Field) spyCount = State<Field>();
    @state(Field) spyAddress = State<Field>();
    @state(PublicKey) adminAddress = State<PublicKey>();
    

    @method initVault() {
        super.init();

        // the admin is set as the zkapp initializer
        this.adminAddress.set(this.sender);

        // this is a root of an empty Merkle Tree of size 256
        this.commitment.set(Field(14472842460125086645444909368571209079194991627904749620726822601198914470820n));

        this.spyCount.set(Field(-1));
        this.spyAddress.set(Field(0));

    }
    /**
     * We take a witness with index the same as the storage count
     * @param spy 
     * @param spyWitness 
     */
    @method storeAddress(spy: PublicKey, spyWitness: SpyMerkleWitness) {
        // assert that only the admin is allowed to store addresses
        this.adminAddress.getAndRequireEquals().assertEquals(this.sender);

        // fetch on-chain address counter and add 1
        let incrementedCount = this.spyCount.getAndRequireEquals().add(1);

        // make sure not to store more than 100 addresses
        incrementedCount.assertLessThan(100, 'Reached maximum storage cap of 100 addresses!');
        
        // make sure storage index is in sync with the on-chain spy counter
        let storageIndex = spyWitness.calculateIndex();
        storageIndex.assertEquals(incrementedCount, 'Off-chain storage index is not compliant!');

        /* 1. check that leaf is empty 
            --> prevent updating an already stored address
           2. check that the off-chain address storage is in sync
            --> a witness of an empty leaf(before update) maintains the same root(commitiment)
        */ 
        let currentCommitment = spyWitness.calculateRoot(Field(0));
        this.commitment.getAndRequireEquals().assertEquals(currentCommitment);

        // hash the address taking advantage of field conversion + masking property
        let addressDigest = Poseidon.hash(spy.toFields());

        // update on-chain spy address
        this.spyAddress.set(addressDigest);
    
        // calculate the new merkle root following the new address storage
        let updatedCommitment = spyWitness.calculateRoot(addressDigest);
        spyWitness.path
        // update the on-chain commitment
        this.commitment.set(updatedCommitment);

        // increment the on-chain count
        this.spyCount.set(incrementedCount);
    }   
}

//TODO Add merkle map for secret message storage
//TODO Bind address tree to the message merkle map