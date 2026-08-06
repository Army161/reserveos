// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @title EvidenceAnchor
/// @notice Append-only commitment log for ReserveOS compliance evidence.
/// @dev Stores hashes only, never content. Reserve positions are commercially
///      sensitive and stay off-chain; this contract exists solely to make their
///      existence and integrity provable at a point in time.
///
///      There is deliberately no update and no delete function. An examiner must
///      be able to reason about this contract in one reading, and every extra
///      capability is something they would have to be convinced is safe.
contract EvidenceAnchor {
    enum SubjectType {
        DailyRollup,
        ReportVersion,
        Approval
    }

    struct Commitment {
        bytes32 merkleRoot;
        SubjectType subjectType;
        bytes32 subjectRef;
        uint64 periodEnd;
        uint64 anchoredAt;
        address submitter;
    }

    Commitment[] private _commitments;

    /// @notice Accounts permitted to append commitments.
    mapping(address => bool) public authorized;

    /// @notice Prevents the same subject being anchored twice.
    /// @dev The anchoring worker retries on failure; without this an ambiguous
    ///      timeout could produce two commitments for one record.
    mapping(bytes32 => bool) public anchoredSubjects;

    address public immutable owner;

    event Anchored(
        uint256 indexed index,
        bytes32 indexed merkleRoot,
        SubjectType indexed subjectType,
        bytes32 subjectRef,
        uint64 periodEnd,
        address submitter
    );

    event AuthorizationChanged(address indexed account, bool allowed);

    error NotAuthorized();
    error ZeroRoot();
    error AlreadyAnchored(bytes32 subjectKey);
    error IndexOutOfRange(uint256 index);

    modifier onlyAuthorized() {
        if (!authorized[msg.sender]) revert NotAuthorized();
        _;
    }

    constructor() {
        owner = msg.sender;
        authorized[msg.sender] = true;
        emit AuthorizationChanged(msg.sender, true);
    }

    /// @notice Grant or revoke append rights. Owner only.
    function setAuthorized(address account, bool allowed) external {
        if (msg.sender != owner) revert NotAuthorized();
        authorized[account] = allowed;
        emit AuthorizationChanged(account, allowed);
    }

    /// @notice Append a commitment.
    /// @param merkleRoot Root over the committed records, or the payload hash for
    ///        a single-record subject such as a report version.
    /// @param subjectType What kind of record this commits to.
    /// @param subjectRef Opaque off-chain identifier (a UUID as bytes32).
    /// @param periodEnd Unix day of the reporting period end, or 0 when not
    ///        period-scoped.
    /// @return index Position of the new commitment.
    function anchor(
        bytes32 merkleRoot,
        SubjectType subjectType,
        bytes32 subjectRef,
        uint64 periodEnd
    ) external onlyAuthorized returns (uint256 index) {
        if (merkleRoot == bytes32(0)) revert ZeroRoot();

        bytes32 subjectKey = keccak256(abi.encodePacked(subjectType, subjectRef));
        if (anchoredSubjects[subjectKey]) revert AlreadyAnchored(subjectKey);
        anchoredSubjects[subjectKey] = true;

        index = _commitments.length;
        _commitments.push(
            Commitment({
                merkleRoot: merkleRoot,
                subjectType: subjectType,
                subjectRef: subjectRef,
                periodEnd: periodEnd,
                anchoredAt: uint64(block.timestamp),
                submitter: msg.sender
            })
        );

        emit Anchored(index, merkleRoot, subjectType, subjectRef, periodEnd, msg.sender);
    }

    /// @notice Read a commitment by position.
    function get(uint256 index) external view returns (Commitment memory) {
        if (index >= _commitments.length) revert IndexOutOfRange(index);
        return _commitments[index];
    }

    /// @notice Total number of commitments.
    function count() external view returns (uint256) {
        return _commitments.length;
    }

    /// @notice Whether a subject has already been anchored.
    function isAnchored(SubjectType subjectType, bytes32 subjectRef)
        external
        view
        returns (bool)
    {
        return anchoredSubjects[keccak256(abi.encodePacked(subjectType, subjectRef))];
    }
}
