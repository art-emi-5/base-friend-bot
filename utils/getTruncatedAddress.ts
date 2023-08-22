import { Address } from 'wagmi';
import {CONTRACT_ADDRESS} from "../utils";

export function getTruncatedAddress(
  address: Address | null | undefined,
  start = 5,
) {
  if (!address) address = CONTRACT_ADDRESS;

  return (
    address.substring(0, start) +
    '...' +
    address.substring(address.length - 4, address.length)
  );
}
