export function checkDuplicateVote(votes, agendaId, voterName) {
  return votes.some((v) => v.agendaId === agendaId && v.voterName === voterName);
}

